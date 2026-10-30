import { sql, sqlOne, table } from "../../db.server";
import type { AgentId, RunContext } from "../types";

export interface ToolCallRecord {
  id: string;
  agent: string;
  tool: string;
  kind: "read" | "write";
  status: "ok" | "error";
  summary: string | null;
  errorCode: string | null;
  idempotencyKey: string | null;
  durationMs: number;
  result: unknown;
  createdAt: string;
}

function mapRow(row: Record<string, unknown>): ToolCallRecord {
  return {
    id: String(row["id"]),
    agent: String(row["agent"]),
    tool: String(row["tool"]),
    kind: row["kind"] as ToolCallRecord["kind"],
    status: row["status"] as ToolCallRecord["status"],
    summary: row["summary"] ? String(row["summary"]) : null,
    errorCode: row["error_code"] ? String(row["error_code"]) : null,
    idempotencyKey: row["idempotency_key"] ? String(row["idempotency_key"]) : null,
    durationMs: Number(row["duration_ms"] ?? 0),
    result: row["result"] ?? null,
    createdAt: new Date(String(row["created_at"])).toISOString(),
  };
}

/** A successful write with the same tool and key is replayed, never re-run. */
export async function findToolCall(
  schema: string,
  tool: string,
  idempotencyKey: string,
): Promise<ToolCallRecord | null> {
  const row = await sqlOne<Record<string, unknown>>(
    `select id, agent, tool, kind, status, summary, error_code, idempotency_key,
            duration_ms, result, created_at
       from ${table(schema, "tool_calls")}
      where tool = $1 and idempotency_key = $2 and status = 'ok'
      limit 1`,
    [tool, idempotencyKey],
  );
  return row ? mapRow(row) : null;
}

export async function insertToolCall(
  context: RunContext,
  input: {
    agent: AgentId;
    tool: string;
    kind: "read" | "write";
    status: "ok" | "error";
    summary: string | null;
    errorCode?: string | null;
    idempotencyKey?: string | null;
    durationMs: number;
    result?: unknown;
  },
): Promise<void> {
  await sql(
    `insert into ${table(context.schema, "tool_calls")}
      (run_id, user_id, chat_id, document_id, record_id, agent, tool, kind, status,
       error_code, summary, idempotency_key, duration_ms, result)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
     on conflict do nothing`,
    [
      context.traceId,
      context.userId,
      context.chatId,
      context.documentId,
      context.recordId,
      input.agent,
      input.tool,
      input.kind,
      input.status,
      input.errorCode ?? null,
      input.summary?.slice(0, 400) ?? null,
      input.idempotencyKey ?? null,
      input.durationMs,
      input.result === undefined ? null : JSON.stringify(input.result),
    ],
  );
}

export interface ToolCallTotal {
  calls: number;
  writes: number;
  failures: number;
}

export async function toolCallTotals(schema: string, days = 30): Promise<ToolCallTotal> {
  const row = await sqlOne<Record<string, unknown>>(
    `select count(*)::int as calls,
            count(*) filter (where kind = 'write')::int as writes,
            count(*) filter (where status = 'error')::int as failures
       from ${table(schema, "tool_calls")}
      where created_at >= now() - ($1 || ' days')::interval`,
    [String(days)],
  );
  return {
    calls: Number(row?.["calls"] ?? 0),
    writes: Number(row?.["writes"] ?? 0),
    failures: Number(row?.["failures"] ?? 0),
  };
}
