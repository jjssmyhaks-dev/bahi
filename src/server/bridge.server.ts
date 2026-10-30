import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

import type { BridgeAgentRow, BridgeCommandRow, JsonObject, SessionUser } from "@/lib/types";
import { env } from "./env.server";
import { sql, sqlOne, table, withTransaction } from "./db.server";
import type { TallyVoucherPayload } from "./posting.server";

export const BRIDGE_COMMAND_TYPES = [
  "ping",
  "sync_masters",
  "post_voucher",
  "post_voucher_draft",
  "get_voucher_status",
  "cancel_voucher",
  "get_company_info",
] as const;

export type BridgeCommandType = (typeof BRIDGE_COMMAND_TYPES)[number];

export type BridgePayload =
  | { type: "ping" }
  | { type: "sync_masters"; page?: number; pageSize?: number }
  | { type: "post_voucher"; voucher: TallyVoucherPayload }
  | { type: "post_voucher_draft"; voucher: TallyVoucherPayload }
  | { type: "get_voucher_status"; idempotencyKey: string }
  | { type: "cancel_voucher"; voucherNumber: string; reason?: string }
  | { type: "get_company_info" };

export interface BridgeCommand {
  id: string;
  type: BridgeCommandType;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface BridgeCommandResult {
  queued: boolean;
  command: BridgeCommand;
  message: string;
}

const REQUIRED: Record<BridgeCommandType, string[]> = {
  ping: [],
  sync_masters: [],
  post_voucher: ["voucher"],
  post_voucher_draft: ["voucher"],
  get_voucher_status: ["idempotencyKey"],
  cancel_voucher: ["voucherNumber"],
  get_company_info: [],
};

export function buildBridgeCommand(input: {
  type: BridgeCommandType;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
}): { ok: true; command: BridgeCommand } | { ok: false; message: string } {
  const payload = input.payload ?? {};
  const missing = REQUIRED[input.type].filter((key) => {
    const value = payload[key];
    return value === undefined || value === null || value === "";
  });
  if (missing.length) {
    return { ok: false, message: `This command needs: ${missing.join(", ")}.` };
  }
  if (!input.idempotencyKey.trim()) {
    return { ok: false, message: "Every bridge command needs an idempotency key." };
  }
  return {
    ok: true,
    command: {
      id: randomUUID(),
      type: input.type,
      idempotencyKey: input.idempotencyKey.trim(),
      payload,
      createdAt: new Date().toISOString(),
    },
  };
}

/**
 * Shapes and validates a command without touching a queue. Kept for callers that
 * only need the payload shape; enqueueBridgeCommand is the real queue.
 */
export function queueBridgeCommand(input: {
  type: BridgeCommandType;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
}): BridgeCommandResult {
  const built = buildBridgeCommand(input);
  if (!built.ok) {
    return {
      queued: false,
      command: {
        id: randomUUID(),
        type: input.type,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload ?? {},
        createdAt: new Date().toISOString(),
      },
      message: built.message,
    };
  }
  return {
    queued: false,
    command: built.command,
    message:
      "No Tally bridge agent is connected in this build. Use the voucher XML download or configure the bridge.",
  };
}

// Credentials -----------------------------------------------------------------

export function hashBridgeToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newBridgeToken(): string {
  return `bhai_${randomBytes(24).toString("hex")}`;
}

export interface BridgeAgentView extends BridgeAgentRow {
  online: boolean;
}

export interface CreatedBridgeAgent {
  agent: BridgeAgentView;
  token: string;
}

function agentView(row: {
  id: string;
  label: string;
  company_name: string;
  status: "active" | "revoked";
  version: string | null;
  last_seen_at: Date | null;
  last_error: string | null;
  created_at: Date;
}): BridgeAgentView {
  const lastSeen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
  return {
    id: row.id,
    label: row.label,
    companyName: row.company_name,
    status: row.status,
    version: row.version,
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
    lastError: row.last_error,
    createdAt: new Date(row.created_at).toISOString(),
    online: row.status === "active" && Date.now() - lastSeen < 120_000,
  };
}

export async function createBridgeAgent(
  session: SessionUser,
  input: { label: string; companyName: string },
): Promise<CreatedBridgeAgent> {
  if (session.role !== "owner") {
    throw new Error("Only the workspace owner can register a bridge agent.");
  }
  const label = input.label.trim();
  const companyName = input.companyName.trim();
  if (!label) throw new Error("Give the agent a name so you can tell agents apart.");
  if (!companyName) throw new Error("The Tally company name is required.");

  const token = newBridgeToken();
  const row = await sqlOne<{
    id: string;
    label: string;
    company_name: string;
    status: "active" | "revoked";
    version: string | null;
    last_seen_at: Date | null;
    last_error: string | null;
    created_at: Date;
  }>(
    `insert into bahi.bridge_agents (tenant_id, label, company_name, token_hash)
     values ($1, $2, $3, $4)
     returning id, label, company_name, status, version, last_seen_at, last_error, created_at`,
    [session.tenantId, label, companyName, hashBridgeToken(token)],
  );
  if (!row) throw new Error("The bridge agent could not be registered.");
  await sql(
    `insert into ${table(session.schema, "activity")} (user_id, action, detail)
     values ($1, 'bridge.agent_created', $2::jsonb)`,
    [session.userId, JSON.stringify({ agentId: row.id, companyName })],
  );
  return { agent: agentView(row), token };
}

export async function listBridgeAgents(session: SessionUser): Promise<BridgeAgentView[]> {
  const rows = await sql<{
    id: string;
    label: string;
    company_name: string;
    status: "active" | "revoked";
    version: string | null;
    last_seen_at: Date | null;
    last_error: string | null;
    created_at: Date;
  }>(
    `select id, label, company_name, status, version, last_seen_at, last_error, created_at
       from bahi.bridge_agents where tenant_id = $1 order by created_at desc`,
    [session.tenantId],
  );
  return rows.map(agentView);
}

export async function revokeBridgeAgent(session: SessionUser, agentId: string): Promise<void> {
  if (session.role !== "owner") {
    throw new Error("Only the workspace owner can revoke a bridge agent.");
  }
  await sql(
    `update bahi.bridge_agents set status = 'revoked', revoked_at = now()
      where id = $1 and tenant_id = $2`,
    [agentId, session.tenantId],
  );
  await sql(
    `update ${table(session.schema, "bridge_commands")}
        set status = 'expired', completed_at = now(), error = 'The agent was revoked.'
      where agent_id = $1 and status in ('queued', 'delivered')`,
    [agentId],
  );
}

export interface BridgeAgentIdentity {
  agentId: string;
  tenantId: string;
  schema: string;
  label: string;
  companyName: string;
}

export async function authenticateBridgeToken(token: string): Promise<BridgeAgentIdentity | null> {
  const clean = token.trim();
  if (clean.length < 16) return null;
  const row = await sqlOne<{
    id: string;
    tenant_id: string;
    schema_name: string;
    label: string;
    company_name: string;
  }>(
    `select a.id, a.tenant_id, t.schema_name, a.label, a.company_name
       from bahi.bridge_agents a
       join bahi.tenants t on t.id = a.tenant_id
      where a.token_hash = $1 and a.status = 'active'
      limit 1`,
    [hashBridgeToken(clean)],
  );
  if (!row) return null;
  return {
    agentId: row.id,
    tenantId: row.tenant_id,
    schema: row.schema_name,
    label: row.label,
    companyName: row.company_name,
  };
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

export function bridgeSigningEnabled(): boolean {
  return Boolean(env.bridge.signingSecret);
}

export function bridgeJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function touchBridgeAgent(
  agentId: string,
  input: { version?: string | null; tallyUrl?: string | null; lastError?: string | null } = {},
): Promise<void> {
  await sql(
    `update bahi.bridge_agents
        set last_seen_at = now(),
            version = coalesce($2, version),
            tally_url = coalesce($3, tally_url),
            last_error = $4
      where id = $1`,
    [agentId, input.version ?? null, input.tallyUrl ?? null, input.lastError ?? null],
  );
}

// Queue -----------------------------------------------------------------------

function voucherOf(payload: Record<string, unknown>): TallyVoucherPayload | null {
  const voucher = payload["voucher"];
  if (!voucher || typeof voucher !== "object") return null;
  const candidate = voucher as Partial<TallyVoucherPayload>;
  if (!Array.isArray(candidate.entries) || typeof candidate.total !== "number") return null;
  return candidate as TallyVoucherPayload;
}

function imbalance(payload: Record<string, unknown>): string | null {
  const voucher = voucherOf(payload);
  if (!voucher) return null;
  const debit = voucher.entries
    .filter((entry) => entry.direction === "debit")
    .reduce((sum, entry) => sum + Number(entry.amount ?? 0), 0);
  const credit = voucher.entries
    .filter((entry) => entry.direction === "credit")
    .reduce((sum, entry) => sum + Number(entry.amount ?? 0), 0);
  if (Math.abs(debit - credit) > 0.01) {
    return "The voucher does not balance, so it was not queued.";
  }
  return null;
}

export interface EnqueueInput {
  type: BridgeCommandType;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  recordId?: string | null;
  agentId?: string | null;
}

export type EnqueueResult =
  | { queued: true; commandId: string; agentId: string; companyName: string }
  | { queued: false; message: string };

export async function enqueueBridgeCommand(
  session: SessionUser,
  input: EnqueueInput,
): Promise<EnqueueResult> {
  const built = buildBridgeCommand(input);
  if (!built.ok) return { queued: false, message: built.message };
  const shortfall = imbalance(built.command.payload);
  if (shortfall) return { queued: false, message: shortfall };

  const agent = input.agentId
    ? await sqlOne<{ id: string; company_name: string }>(
        `select id, company_name from bahi.bridge_agents
          where id = $1 and tenant_id = $2 and status = 'active'`,
        [input.agentId, session.tenantId],
      )
    : await sqlOne<{ id: string; company_name: string }>(
        `select id, company_name from bahi.bridge_agents
          where tenant_id = $1 and status = 'active'
          order by last_seen_at desc nulls last, created_at desc limit 1`,
        [session.tenantId],
      );
  if (!agent) {
    return {
      queued: false,
      message:
        "No Tally bridge agent is registered. Add one in Settings and run the bridge on the Tally computer.",
    };
  }

  const voucher = built.command.payload["voucher"] as { company?: string } | undefined;
  if (voucher && typeof voucher === "object") voucher.company = agent.company_name;

  const row = await sqlOne<{ id: string }>(
    `insert into ${table(session.schema, "bridge_commands")}
       (agent_id, type, idempotency_key, payload, record_id)
     values ($1, $2, $3, $4::jsonb, $5)
     on conflict (agent_id, idempotency_key) do update
       set idempotency_key = excluded.idempotency_key
     returning id`,
    [
      agent.id,
      input.type,
      input.idempotencyKey,
      JSON.stringify(built.command.payload),
      input.recordId ?? null,
    ],
  );
  if (!row) return { queued: false, message: "The command could not be queued." };
  return { queued: true, commandId: row.id, agentId: agent.id, companyName: agent.company_name };
}

export interface PolledCommand {
  id: string;
  type: BridgeCommandType;
  idempotencyKey: string;
  payload: JsonObject;
  attempts: number;
  createdAt: string;
}

export interface PollResponse {
  agent: { id: string; label: string; companyName: string };
  issuedAt: string;
  commands: PolledCommand[];
  signed: boolean;
  signature: string | null;
}

function signatureFor(secret: string, issuedAt: string, commands: PolledCommand[]): string {
  return createHmac("sha256", secret).update(JSON.stringify({ issuedAt, commands })).digest("hex");
}

export async function pollBridgeCommands(
  agent: BridgeAgentIdentity,
  limit = env.bridge.pollLimit,
): Promise<PollResponse> {
  const capped = Math.max(1, Math.min(50, Math.trunc(limit) || 1));
  const rows = await withTransaction(async (client) => {
    const selected = await client.query<{
      id: string;
      type: BridgeCommandType;
      idempotency_key: string;
      payload: JsonObject;
      attempts: number;
      created_at: Date;
    }>(
      `select id, type, idempotency_key, payload, attempts, created_at
         from ${table(agent.schema, "bridge_commands")}
        where agent_id = $1
          and (
            status = 'queued'
            or (status = 'delivered' and delivered_at < now() - interval '2 minutes' and attempts < 5)
          )
        order by created_at asc
        limit $2
        for update skip locked`,
      [agent.agentId, capped],
    );
    if (selected.rows.length) {
      await client.query(
        `update ${table(agent.schema, "bridge_commands")}
            set status = 'delivered', delivered_at = now(), attempts = attempts + 1
          where id = any($1::uuid[])`,
        [selected.rows.map((row) => row.id)],
      );
    }
    return selected.rows;
  });

  const commands: PolledCommand[] = rows.map((row) => ({
    id: row.id,
    type: row.type,
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    attempts: Number(row.attempts) + 1,
    createdAt: new Date(row.created_at).toISOString(),
  }));
  const issuedAt = new Date().toISOString();
  const secret = env.bridge.signingSecret;
  return {
    agent: { id: agent.agentId, label: agent.label, companyName: agent.companyName },
    issuedAt,
    commands,
    signed: Boolean(secret),
    signature: secret && commands.length ? signatureFor(secret, issuedAt, commands) : null,
  };
}

export interface AckResult {
  id: string;
  status: "acked" | "failed";
  result?: Record<string, unknown>;
  error?: string;
}

export interface AckOutcome {
  accepted: number;
  rejected: number;
}

interface StoredCommand {
  id: string;
  type: BridgeCommandType;
  idempotency_key: string;
  record_id: string | null;
}

async function importMasters(
  schema: string,
  result: Record<string, unknown> | undefined,
): Promise<void> {
  const masters = result?.["masters"];
  if (!Array.isArray(masters)) return;
  for (const entry of masters.slice(0, 5_000)) {
    const item = entry as { kind?: unknown; name?: unknown; gstin?: unknown; ledger?: unknown };
    const kind = item.kind;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if ((kind !== "vendor" && kind !== "ledger" && kind !== "item") || !name) continue;
    await sql(
      `insert into ${table(schema, "masters")} (kind, name, gstin, ledger, source, data)
       values ($1, $2, $3, $4, 'tally_bridge', $5::jsonb)
       on conflict (kind, name) do update
         set gstin = coalesce(excluded.gstin, ${table(schema, "masters")}.gstin),
             ledger = coalesce(excluded.ledger, ${table(schema, "masters")}.ledger),
             source = 'tally_bridge'`,
      [
        kind,
        name,
        typeof item.gstin === "string" ? item.gstin.toUpperCase() : null,
        typeof item.ledger === "string" ? item.ledger : null,
        JSON.stringify({ syncedAt: new Date().toISOString() }),
      ],
    );
  }
}

async function applyAck(schema: string, command: StoredCommand, ack: AckResult): Promise<void> {
  const result = ack.result ?? {};
  const externalRef =
    typeof result["voucherNumber"] === "string"
      ? result["voucherNumber"]
      : typeof result["externalRef"] === "string"
        ? result["externalRef"]
        : null;

  if (ack.status === "failed") {
    await sql(
      `update ${table(schema, "posts")}
          set status = 'failed', result = $2::jsonb, completed_at = now()
        where bridge_command_id = $1`,
      [
        command.id,
        JSON.stringify({ ok: false, error: ack.error ?? "The bridge reported a failure." }),
      ],
    );
    if (command.record_id) {
      await sql(
        `update ${table(schema, "records")}
            set status = 'pending_review', destination_note = $2
          where id = $1`,
        [command.record_id, ack.error ?? "The bridge could not post this voucher."],
      );
    }
    return;
  }

  if (command.type === "post_voucher" || command.type === "post_voucher_draft") {
    const draft = command.type === "post_voucher_draft";
    await sql(
      `update ${table(schema, "posts")}
          set status = 'posted', result = $2::jsonb, external_ref = $3, completed_at = now()
        where bridge_command_id = $1`,
      [command.id, JSON.stringify({ ok: true, draft, ...result }), externalRef],
    );
    if (command.record_id) {
      await sql(
        `update ${table(schema, "records")}
            set status = $2,
                destination_ref = coalesce($3, destination_ref),
                destination_note = $4,
                posted_at = case when $2 = 'posted' then now() else posted_at end,
                reviewed_at = coalesce(reviewed_at, now())
          where id = $1`,
        [
          command.record_id,
          draft ? "approved" : "posted",
          externalRef,
          draft
            ? `Created as a draft voucher in Tally${externalRef ? ` (${externalRef})` : ""}.`
            : `Posted to Tally${externalRef ? ` as ${externalRef}` : ""}.`,
        ],
      );
    }
    return;
  }

  if (command.type === "sync_masters") {
    await importMasters(schema, result);
    return;
  }

  if (command.type === "cancel_voucher") {
    const voucherNumber =
      typeof result["voucherNumber"] === "string"
        ? result["voucherNumber"]
        : typeof result["cancelled"] === "string"
          ? result["cancelled"]
          : null;
    await sql(
      `update ${table(schema, "posts")}
          set reversed_at = now(), reversal_ref = $2
        where record_id = $1 and destination = 'tally' and reversed_at is null`,
      [command.record_id, voucherNumber],
    );
    if (command.record_id) {
      await sql(
        `update ${table(schema, "records")}
            set status = 'approved', posted_at = null,
                destination_note = $2
          where id = $1`,
        [
          command.record_id,
          `Voucher cancelled in Tally${voucherNumber ? ` (${voucherNumber})` : ""}.`,
        ],
      );
    }
  }
}

export async function ackBridgeCommands(
  agent: BridgeAgentIdentity,
  results: AckResult[],
): Promise<AckOutcome> {
  let accepted = 0;
  let rejected = 0;
  for (const ack of results.slice(0, 100)) {
    if (!ack?.id || (ack.status !== "acked" && ack.status !== "failed")) {
      rejected += 1;
      continue;
    }
    const command = await sqlOne<StoredCommand>(
      `update ${table(agent.schema, "bridge_commands")}
          set status = $3, result = $4::jsonb, error = $5, completed_at = now()
        where id = $1 and agent_id = $2 and status in ('queued', 'delivered')
        returning id, type, idempotency_key, record_id`,
      [
        ack.id,
        agent.agentId,
        ack.status,
        JSON.stringify(ack.result ?? {}),
        ack.error?.slice(0, 1_000) ?? null,
      ],
    );
    if (!command) {
      rejected += 1;
      continue;
    }
    await applyAck(agent.schema, command, ack);
    accepted += 1;
  }
  return { accepted, rejected };
}

// Status ----------------------------------------------------------------------

export interface BridgeHealth {
  status: "connected" | "offline" | "none";
  detail: string;
  online: number;
  agents: number;
  queued: number;
  failed: number;
}

export async function bridgeHealth(session: SessionUser): Promise<BridgeHealth> {
  const agents = await listBridgeAgents(session);
  const active = agents.filter((agent) => agent.status === "active");
  const counts = await sqlOne<{ queued: number; failed: number }>(
    `select
        count(*) filter (where status in ('queued', 'delivered'))::int as queued,
        count(*) filter (where status = 'failed')::int as failed
      from ${table(session.schema, "bridge_commands")}
      where created_at > now() - interval '7 days'`,
    [],
  );
  const online = active.filter((agent) => agent.online).length;
  const queued = Number(counts?.queued ?? 0);
  const failed = Number(counts?.failed ?? 0);
  if (!active.length) {
    return {
      status: "none",
      detail:
        "No bridge agent is registered. Voucher XML can still be downloaded for manual import.",
      online,
      agents: 0,
      queued,
      failed,
    };
  }
  if (!online) {
    return {
      status: "offline",
      detail: `${active.length} agent${active.length === 1 ? "" : "s"} registered, none polling. Commands wait in the queue.`,
      online,
      agents: active.length,
      queued,
      failed,
    };
  }
  return {
    status: "connected",
    detail: `${online} agent${online === 1 ? "" : "s"} online · ${queued} command${queued === 1 ? "" : "s"} queued.`,
    online,
    agents: active.length,
    queued,
    failed,
  };
}

export async function listBridgeCommands(
  session: SessionUser,
  limit = 25,
): Promise<BridgeCommandRow[]> {
  const rows = await sql<{
    id: string;
    type: string;
    idempotency_key: string;
    status: BridgeCommandRow["status"];
    attempts: number;
    payload: JsonObject;
    result: JsonObject | null;
    error: string | null;
    record_id: string | null;
    created_at: Date;
    delivered_at: Date | null;
    completed_at: Date | null;
  }>(
    `select id, type, idempotency_key, status, attempts, payload, result, error, record_id,
            created_at, delivered_at, completed_at
       from ${table(session.schema, "bridge_commands")}
      order by created_at desc limit $1`,
    [Math.max(1, Math.min(100, limit))],
  );
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempts: Number(row.attempts),
    payload: row.payload,
    result: row.result,
    error: row.error,
    recordId: row.record_id,
    createdAt: new Date(row.created_at).toISOString(),
    deliveredAt: row.delivered_at ? new Date(row.delivered_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  }));
}

export async function queueSyncMasters(session: SessionUser): Promise<EnqueueResult> {
  return enqueueBridgeCommand(session, {
    type: "sync_masters",
    idempotencyKey: `masters-${Date.now()}`,
    payload: { page: 1, pageSize: 5_000 },
  });
}

export async function queueCancelVoucher(
  session: SessionUser,
  input: { recordId: string; voucherNumber: string; voucherType?: string; reason?: string },
): Promise<EnqueueResult> {
  return enqueueBridgeCommand(session, {
    type: "cancel_voucher",
    idempotencyKey: `cancel-${input.recordId}-${Date.now()}`,
    payload: {
      voucherNumber: input.voucherNumber,
      ...(input.voucherType ? { voucherType: input.voucherType } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    },
    recordId: input.recordId,
  });
}
