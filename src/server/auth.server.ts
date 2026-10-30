import { createHash, randomBytes } from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "@tanstack/react-start/server";
import { createClient, type User as SupabaseUser } from "@supabase/supabase-js";

import { mergeSettings, DEFAULT_SETTINGS } from "@/lib/settings";
import type { SessionUser } from "@/lib/types";
import { env } from "./env.server";
import { sql, sqlOne, withTransaction } from "./db.server";

const SESSION_COOKIE = "bahi_session";
const SESSION_DAYS = 30;

export type AuthResult = { ok: true; redirect: string } | { ok: false; error: string };

export function adminClient() {
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function anonClient() {
  return createClient(env.supabaseUrl, env.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function hashToken(token: string): string {
  return createHash("sha256").update(`${token}:${env.sessionSecret}`).digest("hex");
}

function cookieOptions(maxAge?: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.isProduction,
    path: "/",
    ...(maxAge ? { maxAge } : {}),
  };
}

async function createSession(userId: string, tenantId: string) {
  const token = randomBytes(32).toString("hex");
  await sql(
    `insert into bahi.sessions (token_hash, user_id, tenant_id, expires_at)
     values ($1, $2, $3, now() + interval '${SESSION_DAYS} days')`,
    [hashToken(token), userId, tenantId],
  );
  setCookie(SESSION_COOKIE, token, cookieOptions(SESSION_DAYS * 24 * 60 * 60));
  await sql(`delete from bahi.sessions where expires_at < now()`);
}

export async function signOut() {
  const token = getCookie(SESSION_COOKIE);
  if (token) await sql(`delete from bahi.sessions where token_hash = $1`, [hashToken(token)]);
  deleteCookie(SESSION_COOKIE, cookieOptions());
}

interface SessionRow {
  token_hash: string;
  user_id: string;
  tenant_id: string;
  name: string | null;
  email: string;
  role: SessionUser["role"];
  tenant_name: string;
  tenant_slug: string;
  schema_name: string;
  autonomy_mode: SessionUser["autonomyMode"];
  autonomy_stage: number;
  shadow_mode: boolean;
  kill_switch: boolean;
  retention_days: number;
  error_budget_pct: string | number;
  settings: unknown;
}

export async function resolveSession(): Promise<SessionUser | null> {
  const token = getCookie(SESSION_COOKIE);
  const session = await sessionFromToken(token);
  if (!session && token) deleteCookie(SESSION_COOKIE, cookieOptions());
  return session;
}

/** For API route handlers that receive a Request rather than the router context. */
export async function sessionFromRequest(request: Request): Promise<SessionUser | null> {
  const header = request.headers.get("cookie") ?? "";
  const match = header.match(/(?:^|;\s*)bahi_session=([^;]+)/);
  return sessionFromToken(match?.[1]);
}

function toSession(row: SessionRow): SessionUser {
  const settings = mergeSettings(row.settings);
  return {
    userId: row.user_id,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    tenantSlug: row.tenant_slug,
    role: row.role,
    name: row.name ?? row.email.split("@")[0] ?? "Owner",
    email: row.email,
    schema: row.schema_name,
    autonomyMode: row.autonomy_mode,
    autonomyStage: (row.autonomy_stage ?? settings.autonomy.stage) as SessionUser["autonomyStage"],
    shadowMode: row.shadow_mode ?? settings.autonomy.shadowMode,
    killSwitch: row.kill_switch,
    retentionDays: row.retention_days ?? settings.retentionDays,
    errorBudgetPct: Number(row.error_budget_pct ?? settings.autonomy.errorBudgetPct),
    permissionLevel: settings.permissions.level,
    settings,
  };
}

async function sessionFromToken(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const row = await sqlOne<SessionRow>(
    `select s.token_hash, s.user_id, s.tenant_id, u.name, u.email, m.role,
            t.name as tenant_name, t.slug as tenant_slug, t.schema_name,
            t.autonomy_mode, t.autonomy_stage, t.shadow_mode, t.kill_switch,
            t.retention_days, t.error_budget_pct, t.settings
       from bahi.sessions s
       join bahi.users u on u.id = s.user_id
       join bahi.tenants t on t.id = s.tenant_id
       join bahi.memberships m on m.tenant_id = s.tenant_id and m.user_id = s.user_id
      where s.token_hash = $1 and s.expires_at > now() and t.status = 'active'`,
    [hashToken(token)],
  );
  return row ? toSession(row) : null;
}

/**
 * A system session for background work (jobs, intake) that has no request
 * cookie. It acts as the workspace owner so the existing permission checks
 * keep working; callers never expose this session to a client.
 */
export async function sessionForTenant(tenantId: string): Promise<SessionUser | null> {
  const row = await sqlOne<SessionRow>(
    `select null::text as token_hash, u.id as user_id, t.id as tenant_id, u.name, u.email, m.role,
            t.name as tenant_name, t.slug as tenant_slug, t.schema_name,
            t.autonomy_mode, t.autonomy_stage, t.shadow_mode, t.kill_switch,
            t.retention_days, t.error_budget_pct, t.settings
       from bahi.tenants t
       join bahi.memberships m on m.tenant_id = t.id and m.role = 'owner'
       join bahi.users u on u.id = m.user_id
      where t.id = $1 and t.status = 'active'
      order by m.created_at asc
      limit 1`,
    [tenantId],
  );
  return row ? toSession(row) : null;
}

/** Starts a browser session for another workspace, used when accepting an invite. */
export async function startSessionFor(userId: string, tenantId: string): Promise<void> {
  const membership = await sqlOne<{ role: string }>(
    `select role from bahi.memberships where tenant_id = $1 and user_id = $2`,
    [tenantId, userId],
  );
  if (!membership) throw new Error("You are not a member of that workspace.");
  await createSession(userId, tenantId);
}

export async function requireSession(): Promise<SessionUser> {
  const session = await resolveSession();
  if (!session) throw new Error("UNAUTHENTICATED");
  return session;
}

function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return base || "workspace";
}

async function uniqueSlug(desired: string): Promise<string> {
  let slug = desired;
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await sqlOne<{ id: string }>(`select id from bahi.tenants where slug = $1`, [
      slug,
    ]);
    if (!existing) return slug;
    slug = `${desired.slice(0, 24)}-${randomBytes(2).toString("hex")}`;
  }
  return `${desired.slice(0, 20)}-${Date.now().toString(36)}`;
}

interface BootstrapInput {
  userId: string;
  email: string;
  name: string;
  companyName: string;
  role?: "owner" | "reviewer" | "viewer";
  settings?: Record<string, unknown>;
  autonomyMode?: "draft" | "autonomous";
  killSwitch?: boolean;
}

/**
 * Creates the tenant, its isolated Postgres schema, the Google Sheets demo
 * connection and a starter conversation. Runs in one transaction.
 */
export async function bootstrapWorkspace(input: BootstrapInput) {
  const slug = await uniqueSlug(slugify(input.companyName));
  const schemaName = `bahi_t_${slug.replace(/-/g, "_").slice(0, 22)}_${randomBytes(3).toString("hex")}`;
  const settings = mergeSettings({ ...DEFAULT_SETTINGS, ...(input.settings ?? {}) });

  const tenant = await withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `insert into bahi.tenants (name, slug, schema_name, autonomy_mode, kill_switch, settings)
       values ($1, $2, $3, $4, $5, $6::jsonb)
       returning id`,
      [
        input.companyName,
        slug,
        schemaName,
        input.autonomyMode ?? "draft",
        input.killSwitch ?? true,
        JSON.stringify(settings),
      ],
    );
    const tenantId = inserted.rows[0]!.id;

    await client.query(
      `insert into bahi.memberships (tenant_id, user_id, role) values ($1, $2, $3)`,
      [tenantId, input.userId, input.role ?? "owner"],
    );

    await client.query(`select bahi.create_tenant_schema($1)`, [schemaName]);

    await client.query(
      `insert into "${schemaName}".sheet_connections (provider, label, spreadsheet_name, sheet_name)
       values ('google_sheets', 'Daily entries', $1, 'Entries')`,
      [`${input.companyName} — FY 2026–27`],
    );

    // Must run after the sheet connection exists so the standard column mapping is seeded.
    await client.query(`select bahi.ensure_agent_schema($1)`, [schemaName]);
    await client.query(`select bahi.ensure_tool_schema($1)`, [schemaName]);
    await client.query(`select bahi.ensure_gap_schema($1)`, [schemaName]);
    await client.query(`select bahi.ensure_excel_schema($1)`, [schemaName]);

    const chat = await client.query<{ id: string }>(
      `insert into "${schemaName}".chats (user_id, title) values ($1, 'Getting started') returning id`,
      [input.userId],
    );
    const chatId = chat.rows[0]!.id;

    await client.query(
      `insert into "${schemaName}".messages (chat_id, role, content, meta)
       values ($1, 'assistant', $2, $3::jsonb)`,
      [
        chatId,
        `Namaste, I'm Bahi. Upload supplier invoices, purchase orders, goods receipts or bank statements — or paste the details — and I'll read them, check them against GST rules and enter them into Tally, Excel or Google Sheets. A sample invoice is the quickest way to see how it works.`,
        JSON.stringify({ kind: "welcome" }),
      ],
    );

    await client.query(
      `insert into "${schemaName}".activity (user_id, action, detail) values ($1, 'workspace.created', $2::jsonb)`,
      [input.userId, JSON.stringify({ company: input.companyName })],
    );

    return { id: tenantId, slug, schemaName, settings };
  });

  return tenant;
}

export async function findOrCreateUser(authUser: SupabaseUser, name?: string) {
  const email = (authUser.email ?? "").toLowerCase();
  const inserted = await sqlOne<{ id: string; email: string; name: string | null }>(
    `insert into bahi.users (auth_id, email, name)
     values ($1, $2, $3)
     on conflict (auth_id) do update set email = excluded.email,
       name = coalesce(excluded.name, bahi.users.name)
     returning id, email, name`,
    [authUser.id, email, name ?? (authUser.user_metadata?.["name"] as string | undefined) ?? null],
  );
  if (!inserted) throw new Error("Could not create user");
  return inserted;
}

async function firstMembership(userId: string) {
  return sqlOne<{ tenant_id: string; role: "owner" | "reviewer" | "viewer" }>(
    `select tenant_id, role from bahi.memberships where user_id = $1 order by created_at asc limit 1`,
    [userId],
  );
}

export function validateCredentials(email: string, password: string): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return "Enter a valid email address.";
  if (password.length < 8) return "Password must be at least 8 characters.";
  return null;
}

export async function signUp(input: {
  name: string;
  company: string;
  email: string;
  password: string;
}): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();
  const problem = validateCredentials(email, input.password);
  if (problem) return { ok: false, error: problem };
  if (!input.company.trim()) return { ok: false, error: "Enter your company name." };

  const admin = adminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: input.password,
    email_confirm: true,
    user_metadata: { name: input.name.trim() },
  });

  if (error) {
    if (/already|registered|exists/i.test(error.message)) {
      return { ok: false, error: "An account with this email already exists. Sign in instead." };
    }
    return { ok: false, error: error.message };
  }

  const user = await findOrCreateUser(data.user, input.name.trim());
  const existing = await firstMembership(user.id);
  if (existing) {
    await createSession(user.id, existing.tenant_id);
    return { ok: true, redirect: "/app" };
  }

  const tenant = await bootstrapWorkspace({
    userId: user.id,
    email,
    name: input.name.trim(),
    companyName: input.company.trim(),
  });
  await createSession(user.id, tenant.id);
  return { ok: true, redirect: "/app" };
}

export async function signIn(input: { email: string; password: string }): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();
  const problem = validateCredentials(email, input.password);
  if (problem) return { ok: false, error: problem };

  const anon = anonClient();
  const { data, error } = await anon.auth.signInWithPassword({ email, password: input.password });
  if (error || !data.user) {
    return { ok: false, error: "Incorrect email or password." };
  }

  const user = await findOrCreateUser(data.user);
  let membership = await firstMembership(user.id);
  if (!membership) {
    const nameFromEmail = email.split("@")[0]?.replace(/[._-]+/g, " ") ?? "My company";
    const tenant = await bootstrapWorkspace({
      userId: user.id,
      email,
      name: user.name ?? nameFromEmail,
      companyName: `${nameFromEmail} workspace`,
    });
    membership = { tenant_id: tenant.id, role: "owner" };
  }

  await createSession(user.id, membership.tenant_id);
  return { ok: true, redirect: "/app" };
}

export async function signInDemo(): Promise<AuthResult> {
  if (!env.demoPassword) return { ok: false, error: "Demo login is not configured." };

  const anon = anonClient();
  let authUser: SupabaseUser | null = null;

  const signInAttempt = await anon.auth.signInWithPassword({
    email: env.demoEmail,
    password: env.demoPassword,
  });

  if (signInAttempt.data.user) {
    authUser = signInAttempt.data.user;
  } else {
    const admin = adminClient();
    const { data, error } = await admin.auth.admin.createUser({
      email: env.demoEmail,
      password: env.demoPassword,
      email_confirm: true,
      user_metadata: { name: "Demo Owner" },
    });
    if (error || !data.user) {
      return { ok: false, error: `Could not start the demo: ${error?.message ?? "unknown error"}` };
    }
    authUser = data.user;
  }

  if (!authUser) return { ok: false, error: "Could not start the demo." };

  const user = await findOrCreateUser(authUser, "Demo Owner");
  const { ensureDemoWorkspace } = await import("./demo.server");
  const tenant = await ensureDemoWorkspace(user.id, user.email);
  await createSession(user.id, tenant.id);
  return { ok: true, redirect: "/app" };
}
