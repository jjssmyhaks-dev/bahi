import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { JsonObject, SessionUser } from "@/lib/types";
import { sessionForTenant } from "./auth.server";
import { ingestFiles } from "./chat.server";
import { sql, sqlOne, table } from "./db.server";

export type IntakeChannel = "email" | "whatsapp";

export interface IntakeSourceRow {
  id: string;
  channel: IntakeChannel;
  address: string;
  status: "active" | "paused";
  hasSecret: boolean;
  createdAt: string;
}

export interface IntakeFile {
  name: string;
  mimeType: string;
  base64: string;
}

export interface IntakeEventRow {
  id: string;
  channel: string;
  externalId: string | null;
  status: "received" | "processed" | "ignored" | "failed";
  detail: JsonObject;
  documentId: string | null;
  createdAt: string;
}

interface SourceRecord {
  id: string;
  tenantId: string;
  schema: string;
  channel: IntakeChannel;
  address: string;
  secretHash: string | null;
  status: "active" | "paused";
}

const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function listIntakeSources(session: SessionUser): Promise<IntakeSourceRow[]> {
  const rows = await sql<{
    id: string;
    channel: IntakeChannel;
    address: string;
    secret_hash: string | null;
    status: IntakeSourceRow["status"];
    created_at: Date;
  }>(
    `select id, channel, address, secret_hash, status, created_at
       from bahi.intake_sources where tenant_id = $1 order by created_at desc`,
    [session.tenantId],
  );
  return rows.map((row) => ({
    id: String(row.id),
    channel: row.channel,
    address: row.address,
    status: row.status,
    hasSecret: Boolean(row.secret_hash),
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

export async function createIntakeSource(
  session: SessionUser,
  input: { channel: IntakeChannel; address: string },
): Promise<{ source: IntakeSourceRow; secret: string }> {
  if (session.role !== "owner") {
    throw new Error("Only the workspace owner can add an intake address.");
  }
  const address = input.address.trim();
  if (address.length < 3 || address.length > 200) {
    throw new Error("Enter a valid email address or phone number.");
  }
  const secret = `bhai_in_${randomBytes(24).toString("hex")}`;
  const row = await sqlOne<{
    id: string;
    channel: IntakeChannel;
    address: string;
    status: IntakeSourceRow["status"];
    created_at: Date;
  }>(
    `insert into bahi.intake_sources (tenant_id, channel, address, secret_hash)
     values ($1, $2, $3, $4) returning id, channel, address, status, created_at`,
    [session.tenantId, input.channel, address, hashSecret(secret)],
  );
  if (!row) throw new Error("The intake address could not be created.");
  await sql(
    `insert into ${table(session.schema, "activity")} (user_id, action, detail)
     values ($1, 'intake.created', $2::jsonb)`,
    [session.userId, JSON.stringify({ channel: input.channel, address })],
  );
  return {
    source: {
      id: String(row.id),
      channel: row.channel,
      address: row.address,
      status: row.status,
      hasSecret: true,
      createdAt: new Date(row.created_at).toISOString(),
    },
    secret,
  };
}

export async function setIntakeSourceStatus(
  session: SessionUser,
  input: { sourceId: string; status: "active" | "paused" },
): Promise<void> {
  if (session.role !== "owner") {
    throw new Error("Only the workspace owner can change an intake address.");
  }
  await sql(`update bahi.intake_sources set status = $3 where id = $1 and tenant_id = $2`, [
    input.sourceId,
    session.tenantId,
    input.status,
  ]);
}

export async function deleteIntakeSource(session: SessionUser, sourceId: string): Promise<void> {
  if (session.role !== "owner") {
    throw new Error("Only the workspace owner can remove an intake address.");
  }
  await sql(`delete from bahi.intake_sources where id = $1 and tenant_id = $2`, [
    sourceId,
    session.tenantId,
  ]);
}

export async function listIntakeEvents(
  session: SessionUser,
  limit = 10,
): Promise<IntakeEventRow[]> {
  const rows = await sql<{
    id: string;
    channel: string;
    external_id: string | null;
    status: IntakeEventRow["status"];
    detail: JsonObject;
    document_id: string | null;
    created_at: Date;
  }>(
    `select id, channel, external_id, status, detail, document_id, created_at
       from ${table(session.schema, "intake_events")} order by created_at desc limit $1`,
    [limit],
  );
  return rows.map((row) => ({
    id: String(row.id),
    channel: row.channel,
    externalId: row.external_id,
    status: row.status,
    detail: row.detail ?? {},
    documentId: row.document_id,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

async function findSource(channel: IntakeChannel, address: string): Promise<SourceRecord | null> {
  const row = await sqlOne<{
    id: string;
    tenant_id: string;
    channel: IntakeChannel;
    address: string;
    secret_hash: string | null;
    status: SourceRecord["status"];
    tenant_status: string;
    schema_name: string;
  }>(
    `select s.id, s.tenant_id, s.channel, s.address, s.secret_hash, s.status,
            t.status as tenant_status, t.schema_name
       from bahi.intake_sources s
       join bahi.tenants t on t.id = s.tenant_id
      where lower(s.address) = lower($1) and s.channel = $2`,
    [address, channel],
  );
  if (!row || row.status !== "active" || row.tenant_status !== "active") return null;
  return {
    id: String(row.id),
    tenantId: row.tenant_id,
    schema: row.schema_name,
    channel: row.channel,
    address: row.address,
    secretHash: row.secret_hash,
    status: row.status,
  };
}

export async function authenticateIntake(
  channel: IntakeChannel,
  address: string,
  secret: string,
): Promise<SourceRecord | null> {
  const source = await findSource(channel, address);
  if (!source?.secretHash) return null;
  return safeEqual(source.secretHash, hashSecret(secret)) ? source : null;
}

export async function recordIntakeEvent(
  schema: string,
  input: {
    channel: string;
    externalId: string | null;
    status: IntakeEventRow["status"];
    detail?: JsonObject;
    documentId?: string | null;
  },
): Promise<string> {
  const row = await sqlOne<{ id: string }>(
    `insert into ${table(schema, "intake_events")} (channel, external_id, status, detail, document_id)
     values ($1, $2, $3, $4::jsonb, $5) returning id`,
    [
      input.channel,
      input.externalId,
      input.status,
      JSON.stringify(input.detail ?? {}),
      input.documentId ?? null,
    ],
  );
  if (!row) throw new Error("The intake event could not be recorded.");
  return String(row.id);
}

export async function alreadyProcessed(
  schema: string,
  channel: string,
  externalId: string,
): Promise<string | null> {
  const row = await sqlOne<{ id: string }>(
    `select id from ${table(schema, "intake_events")}
      where channel = $1 and external_id = $2 and status = 'processed' limit 1`,
    [channel, externalId],
  );
  return row ? String(row.id) : null;
}

export interface IntakeJobPayload {
  sourceId: string;
  eventId: string;
  channel: IntakeChannel;
  externalId: string | null;
  note: string;
  files: IntakeFile[];
}

export async function processIntakeJob(
  raw: Record<string, unknown>,
): Promise<{ records: number; summary: string }> {
  const payload = raw as unknown as IntakeJobPayload;
  if (!payload?.sourceId || !payload.eventId || !Array.isArray(payload.files)) {
    throw new Error("The intake job is missing its payload.");
  }

  const source = await sqlOne<{
    id: string;
    tenant_id: string;
    channel: IntakeChannel;
    status: SourceRecord["status"];
    schema_name: string;
    tenant_status: string;
  }>(
    `select s.id, s.tenant_id, s.channel, s.status, t.schema_name, t.status as tenant_status
       from bahi.intake_sources s join bahi.tenants t on t.id = s.tenant_id
      where s.id = $1`,
    [payload.sourceId],
  );
  if (!source || source.status !== "active" || source.tenant_status !== "active") {
    throw new Error("The intake address is paused or no longer exists.");
  }

  const session = await sessionForTenant(source.tenant_id);
  if (!session) throw new Error("The workspace has no owner to receive documents.");

  try {
    const result = await ingestFiles(session, {
      files: payload.files.map((file) => ({
        name: file.name,
        mimeType: file.mimeType,
        base64: file.base64,
      })),
      note: payload.note || `Received by ${payload.channel}.`,
      sourceChannel: payload.channel,
    });
    // ingestFiles reuses the latest chat and returns every record in it, so count
    // only the documents and records this intake run actually created.
    const stored = new Set(result.documentIds);
    const records = result.records.filter(
      (record) => record.documentId && stored.has(record.documentId),
    ).length;
    const summary = result.messages.at(-1)?.content.slice(0, 400) ?? "Documents received.";
    const documentId = result.documentIds[0] ?? null;

    await sql(
      `update ${table(session.schema, "intake_events")}
          set status = 'processed', detail = $2::jsonb, document_id = $3
        where id = $1`,
      [payload.eventId, JSON.stringify({ records, summary }), documentId],
    );
    return { records, summary };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message.slice(0, 400) : "Intake failed.";
    await sql(
      `update ${table(session.schema, "intake_events")} set status = 'failed', detail = $2::jsonb where id = $1`,
      [payload.eventId, JSON.stringify({ error: message })],
    );
    throw caught;
  }
}
