import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type { SessionUser } from "@/lib/types";
import { env } from "./env.server";
import { sql, sqlOne, table } from "./db.server";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_URL = "https://sheets.googleapis.com/v4/spreadsheets";
export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

// Token encryption ------------------------------------------------------------

function encryptionKey(): Buffer {
  const raw = env.tokenEncryptionKey.trim();
  if (!raw) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set, so Google tokens cannot be stored. Add a 32-byte key and restart.",
    );
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 32) return decoded;
  return createHash("sha256").update(raw).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(
    ".",
  );
}

export function decryptSecret(value: string): string {
  const [version, iv, tag, payload] = value.split(".");
  if (version !== "v1" || !iv || !tag || !payload) {
    throw new Error("Stored Google token is not in the expected format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

// OAuth -----------------------------------------------------------------------

export function googleConfigured(): boolean {
  return Boolean(env.google.clientId && env.google.clientSecret);
}

export function googleRedirectUri(): string {
  return env.google.redirectUri || (env.appBaseUrl ? `${env.appBaseUrl}/api/google/callback` : "");
}

export async function createOAuthState(
  tenantId: string,
  userId: string,
  provider: "google_sheets",
  redirectTo: string,
): Promise<string> {
  const state = randomBytes(24).toString("hex");
  await sql(
    `insert into bahi.oauth_states (state_hash, tenant_id, user_id, provider, redirect_to, expires_at)
     values ($1, $2, $3, $4, $5, now() + interval '10 minutes')`,
    [createHash("sha256").update(state).digest("hex"), tenantId, userId, provider, redirectTo],
  );
  await sql(`delete from bahi.oauth_states where expires_at < now() - interval '1 day'`);
  return state;
}

export async function consumeOAuthState(
  state: string,
  provider: "google_sheets",
): Promise<{ tenantId: string; userId: string; redirectTo: string | null } | null> {
  if (!state) return null;
  const row = await sqlOne<{
    tenant_id: string;
    user_id: string;
    redirect_to: string | null;
  }>(
    `delete from bahi.oauth_states
      where state_hash = $1 and provider = $2 and expires_at > now()
      returning tenant_id, user_id, redirect_to`,
    [createHash("sha256").update(state).digest("hex"), provider],
  );
  return row ? { tenantId: row.tenant_id, userId: row.user_id, redirectTo: row.redirect_to } : null;
}

export function googleConsentUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.google.clientId,
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  id_token?: string;
}

async function tokenRequest(body: URLSearchParams): Promise<GoogleTokens> {
  if (!googleConfigured()) throw new Error("Google OAuth is not configured on this server.");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof data["access_token"] !== "string") {
    const detail =
      typeof data["error_description"] === "string"
        ? data["error_description"]
        : typeof data["error"] === "string"
          ? data["error"]
          : `HTTP ${response.status}`;
    throw new Error(`Google refused the token request: ${detail}`);
  }
  return {
    access_token: data["access_token"],
    ...(typeof data["refresh_token"] === "string" ? { refresh_token: data["refresh_token"] } : {}),
    expires_in: Number(data["expires_in"] ?? 3600),
    scope: String(data["scope"] ?? GOOGLE_SCOPES.join(" ")),
    ...(typeof data["id_token"] === "string" ? { id_token: data["id_token"] } : {}),
  };
}

export async function exchangeGoogleCode(code: string): Promise<GoogleTokens> {
  return tokenRequest(
    new URLSearchParams({
      code,
      client_id: env.google.clientId,
      client_secret: env.google.clientSecret,
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    }),
  );
}

async function refreshGoogleToken(refreshToken: string): Promise<GoogleTokens> {
  return tokenRequest(
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.google.clientId,
      client_secret: env.google.clientSecret,
      grant_type: "refresh_token",
    }),
  );
}

function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: unknown;
    };
    return typeof parsed.email === "string" ? parsed.email : null;
  } catch {
    return null;
  }
}

export interface GoogleConnection {
  id: string;
  spreadsheetId: string | null;
  spreadsheetName: string;
  sheetName: string;
  status: string;
}

export async function storeGoogleTokens(
  session: SessionUser,
  tokens: GoogleTokens,
): Promise<GoogleConnection> {
  if (session.role === "viewer") throw new Error("Viewers cannot connect Google Sheets.");
  const email = emailFromIdToken(tokens.id_token) ?? "Google account";
  const encryptedAccess = encryptSecret(tokens.access_token);
  const encryptedRefresh = tokens.refresh_token ? encryptSecret(tokens.refresh_token) : null;
  const expiresAt = new Date(Date.now() + Math.max(60, tokens.expires_in) * 1000).toISOString();

  const existing = await sqlOne<{ id: string }>(
    `select id from ${table(session.schema, "sheet_connections")}
      where provider = 'google_sheets' order by created_at asc limit 1`,
  );
  if (existing) {
    await sql(
      `update ${table(session.schema, "sheet_connections")}
          set label = $2,
              status = case when spreadsheet_id is null then 'revoked' else 'connected' end,
              access_token_enc = $3,
              refresh_token_enc = coalesce($4, refresh_token_enc),
              token_expires_at = $5,
              scope = $6
        where id = $1`,
      [existing.id, email, encryptedAccess, encryptedRefresh, expiresAt, tokens.scope],
    );
  } else {
    await sql(
      `insert into ${table(session.schema, "sheet_connections")}
         (provider, label, spreadsheet_name, sheet_name, status, access_token_enc,
          refresh_token_enc, token_expires_at, scope)
       values ('google_sheets', $1, 'No spreadsheet chosen', 'Entries', 'revoked',
               $2, $3, $4, $5)`,
      [email, encryptedAccess, encryptedRefresh, expiresAt, tokens.scope],
    );
  }
  await sql(
    `insert into ${table(session.schema, "activity")} (user_id, action, detail)
     values ($1, 'connection.google_authorized', $2::jsonb)`,
    [session.userId, JSON.stringify({ email })],
  );
  const connection = await sqlOne<GoogleConnection>(
    `select id, spreadsheet_id as "spreadsheetId", spreadsheet_name as "spreadsheetName",
            sheet_name as "sheetName", status
       from ${table(session.schema, "sheet_connections")}
      where provider = 'google_sheets' order by created_at asc limit 1`,
  );
  if (!connection) throw new Error("The Google connection could not be stored.");
  return connection;
}

// Sheets API ------------------------------------------------------------------

interface StoredConnection {
  id: string;
  spreadsheet_id: string | null;
  spreadsheet_name: string;
  sheet_name: string;
  status: string;
  refresh_token_enc: string | null;
  access_token_enc: string | null;
  token_expires_at: Date | null;
}

async function loadConnection(schema: string): Promise<StoredConnection | null> {
  return sqlOne<StoredConnection>(
    `select id, spreadsheet_id, spreadsheet_name, sheet_name, status,
            refresh_token_enc, access_token_enc, token_expires_at
       from ${table(schema, "sheet_connections")}
      where provider = 'google_sheets' order by created_at asc limit 1`,
  );
}

async function accessToken(schema: string, connection: StoredConnection): Promise<string> {
  const expires = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : 0;
  if (connection.access_token_enc && expires > Date.now() + 60_000) {
    return decryptSecret(connection.access_token_enc);
  }
  if (!connection.refresh_token_enc) {
    throw new Error("Google sign-in has expired. Connect Google Sheets again.");
  }
  const tokens = await refreshGoogleToken(decryptSecret(connection.refresh_token_enc));
  const encryptedAccess = encryptSecret(tokens.access_token);
  const nextExpiry = new Date(Date.now() + Math.max(60, tokens.expires_in) * 1000).toISOString();
  await sql(
    `update ${table(schema, "sheet_connections")}
        set access_token_enc = $2, token_expires_at = $3, scope = $4
      where id = $1`,
    [connection.id, encryptedAccess, nextExpiry, tokens.scope],
  );
  connection.access_token_enc = encryptedAccess;
  connection.token_expires_at = new Date(nextExpiry);
  return tokens.access_token;
}

async function sheetsFetch(
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(`${SHEETS_URL}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      (data["error"] as { message?: string } | undefined)?.message ?? `HTTP ${response.status}`;
    throw new Error(`Google Sheets: ${message}`);
  }
  return data;
}

function quoteSheet(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

export function parseSpreadsheetId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const fromUrl = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (fromUrl?.[1]) return fromUrl[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(trimmed) ? trimmed : null;
}

export interface SpreadsheetSummary {
  id: string;
  title: string;
  sheetName: string;
  url: string;
}

export async function chooseSpreadsheet(
  session: SessionUser,
  input: { spreadsheet: string; sheetName?: string | undefined },
): Promise<SpreadsheetSummary> {
  if (session.role === "viewer") throw new Error("Viewers cannot change connections.");
  const connection = await loadConnection(session.schema);
  if (!connection) throw new Error("Sign in with Google first.");
  const id = parseSpreadsheetId(input.spreadsheet);
  if (!id) throw new Error("Paste a Google Sheets link or a spreadsheet ID.");
  const token = await accessToken(session.schema, connection);
  const data = await sheetsFetch(
    `/${id}?fields=spreadsheetId,properties.title,sheets.properties.title`,
    token,
  );
  const title = String((data["properties"] as { title?: string } | undefined)?.title ?? "Untitled");
  const sheetNames = (data["sheets"] as { properties?: { title?: string } }[] | undefined) ?? [];
  const tabs = sheetNames
    .map((entry) => entry.properties?.title ?? "")
    .filter((name) => name.length > 0);
  const wanted = input.sheetName?.trim();
  const sheetName = wanted && tabs.includes(wanted) ? wanted : (tabs[0] ?? "Sheet1");

  const headerRange = `${quoteSheet(sheetName)}!A1:N1`;
  const existing = (await sheetsFetch(
    `/${id}/values/${encodeURIComponent(headerRange)}`,
    token,
  )) as { values?: string[][] };
  const firstRow = existing.values?.[0]?.join("").trim() ?? "";
  if (!firstRow) {
    const { SHEET_HEADER_ROW } = await import("./posting.server");
    await sheetsFetch(
      `/${id}/values/${encodeURIComponent(`${quoteSheet(sheetName)}!A1`)}?valueInputOption=RAW`,
      token,
      { method: "PUT", body: { values: [SHEET_HEADER_ROW] } },
    );
  }

  await sql(
    `update ${table(session.schema, "sheet_connections")}
        set spreadsheet_id = $2, spreadsheet_name = $3, spreadsheet_url = $4,
            sheet_name = $5, status = 'connected', last_synced_at = now()
      where id = $1`,
    [connection.id, id, title, `https://docs.google.com/spreadsheets/d/${id}`, sheetName],
  );
  await sql(
    `insert into ${table(session.schema, "activity")} (user_id, action, detail)
     values ($1, 'connection.sheet_chosen', $2::jsonb)`,
    [session.userId, JSON.stringify({ spreadsheetId: id, sheetName })],
  );
  return { id, title, sheetName, url: `https://docs.google.com/spreadsheets/d/${id}` };
}

export interface AppendedRow {
  rowNumber: number;
  updatedRange: string;
}

export async function appendSheetRow(
  schema: string,
  values: (string | number)[],
): Promise<AppendedRow> {
  const connection = await loadConnection(schema);
  if (!connection) throw new Error("No Google Sheet is connected.");
  if (!connection.spreadsheet_id) throw new Error("Choose a spreadsheet in Settings first.");
  const token = await accessToken(schema, connection);
  const range = encodeURIComponent(`${quoteSheet(connection.sheet_name)}!A1`);
  const data = await sheetsFetch(
    `/${connection.spreadsheet_id}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    token,
    { method: "POST", body: { values: [values] } },
  );
  const updatedRange = String(
    (data["updates"] as { updatedRange?: string } | undefined)?.updatedRange ?? "",
  );
  const rowNumber = Number(updatedRange.match(/![A-Z]*(\d+)/)?.[1] ?? 0) || 0;
  await sql(
    `update ${table(schema, "sheet_connections")} set last_synced_at = now() where id = $1`,
    [connection.id],
  );
  return { rowNumber, updatedRange };
}

async function sheetIdByTitle(
  spreadsheetId: string,
  title: string,
  token: string,
): Promise<number | null> {
  const data = await sheetsFetch(
    `/${spreadsheetId}?fields=sheets.properties(sheetId,title)`,
    token,
  );
  const sheets = (data["sheets"] as { properties?: { sheetId?: number; title?: string } }[]) ?? [];
  const match = sheets.find((entry) => entry.properties?.title === title);
  return typeof match?.properties?.sheetId === "number" ? match.properties.sheetId : null;
}

export async function deleteSheetRow(schema: string, rowNumber: number): Promise<void> {
  const connection = await loadConnection(schema);
  if (!connection?.spreadsheet_id) throw new Error("No Google Sheet is connected.");
  if (rowNumber < 2) throw new Error("The header row cannot be removed.");
  const token = await accessToken(schema, connection);
  const sheetId = await sheetIdByTitle(connection.spreadsheet_id, connection.sheet_name, token);
  if (sheetId === null) throw new Error("The connected tab no longer exists in the spreadsheet.");
  await sheetsFetch(`/${connection.spreadsheet_id}:batchUpdate`, token, {
    method: "POST",
    body: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: rowNumber - 1,
              endIndex: rowNumber,
            },
          },
        },
      ],
    },
  });
}

// Health ----------------------------------------------------------------------

export interface SheetHealth {
  status: "connected" | "needs_sign_in" | "not_configured" | "needs_spreadsheet";
  detail: string;
  spreadsheetName: string | null;
  sheetName: string | null;
  url: string | null;
}

export async function googleSheetHealth(session: SessionUser): Promise<SheetHealth> {
  const connection = await loadConnection(session.schema);
  if (!googleConfigured()) {
    return {
      status: "not_configured",
      detail:
        "Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY.",
      spreadsheetName: connection?.spreadsheet_name ?? null,
      sheetName: connection?.sheet_name ?? null,
      url: null,
    };
  }
  if (!connection?.refresh_token_enc) {
    return {
      status: "needs_sign_in",
      detail: "Sign in with Google to allow Bahi to append rows to a spreadsheet you choose.",
      spreadsheetName: null,
      sheetName: null,
      url: null,
    };
  }
  if (!connection.spreadsheet_id) {
    return {
      status: "needs_spreadsheet",
      detail: "Google is connected. Choose the spreadsheet and tab Bahi should write to.",
      spreadsheetName: null,
      sheetName: null,
      url: null,
    };
  }
  try {
    await accessToken(session.schema, connection);
  } catch (error) {
    return {
      status: "needs_sign_in",
      detail: error instanceof Error ? error.message : "Google sign-in expired.",
      spreadsheetName: connection.spreadsheet_name,
      sheetName: connection.sheet_name,
      url: connection.spreadsheet_id
        ? `https://docs.google.com/spreadsheets/d/${connection.spreadsheet_id}`
        : null,
    };
  }
  return {
    status: "connected",
    detail: `${connection.spreadsheet_name} · ${connection.sheet_name}`,
    spreadsheetName: connection.spreadsheet_name,
    sheetName: connection.sheet_name,
    url: `https://docs.google.com/spreadsheets/d/${connection.spreadsheet_id}`,
  };
}
