import { sql, sqlOne, table } from "../db.server";
import type {
  AgentEnvelope,
  AgentId,
  AgentMode,
  CuratorRule,
  MatchResult,
  RunContext,
  SegmentDescriptor,
} from "./types";

export interface AgentRunInput {
  agent: AgentId;
  promptVersion: string;
  model: string | null;
  mode: AgentMode;
  status: "success" | "retried" | "failed";
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  error?: string | null;
}

export async function insertAgentRun(context: RunContext, input: AgentRunInput): Promise<string> {
  const row = await sqlOne<{ id: string }>(
    `insert into ${table(context.schema, "agent_runs")}
      (user_id, chat_id, document_id, record_id, agent, prompt_version, model, mode, status,
       input_tokens, output_tokens, cost_usd, latency_ms, trace_id, error)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     returning id`,
    [
      context.userId,
      context.chatId,
      context.documentId,
      context.recordId,
      input.agent,
      input.promptVersion,
      input.model,
      input.mode,
      input.status,
      input.inputTokens,
      input.outputTokens,
      input.costUsd,
      input.latencyMs,
      context.traceId,
      input.error ?? null,
    ],
  );
  if (!row) throw new Error("Could not record the agent run.");
  return row.id;
}

export interface SegmentRow extends SegmentDescriptor {
  index: number;
}

export async function saveSegments(
  context: RunContext,
  documentId: string,
  segments: SegmentRow[],
): Promise<void> {
  await sql(`delete from ${table(context.schema, "document_segments")} where document_id = $1`, [
    documentId,
  ]);
  for (const segment of segments) {
    await sql(
      `insert into ${table(context.schema, "document_segments")}
        (document_id, segment_index, page_start, page_end, doc_type, confidence, quality, status)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        documentId,
        segment.index,
        segment.pageStart,
        segment.pageEnd,
        segment.docType === "unknown" ? null : segment.docType,
        segment.confidence,
        JSON.stringify(segment.quality),
        segment.docType === "unknown" ? "unknown" : "pending",
      ],
    );
  }
}

export async function markSegmentsExtracted(
  context: RunContext,
  documentId: string,
  status: "extracted" | "failed",
): Promise<void> {
  await sql(
    `update ${table(context.schema, "document_segments")}
        set status = $2
      where document_id = $1 and status <> 'unknown'`,
    [documentId, status],
  );
}

export interface StoredExtractionRow {
  payload: unknown;
  envelope: AgentEnvelope;
}

export async function findCachedExtraction(
  context: RunContext,
  documentId: string,
  segmentIndex: number,
): Promise<StoredExtractionRow | null> {
  const row = await sqlOne<Record<string, unknown>>(
    `select fields, envelope from ${table(context.schema, "extractions")}
      where document_id = $1 and segment_index = $2 and pack_version = $3
      order by created_at desc limit 1`,
    [documentId, segmentIndex, context.pack.version],
  );
  if (!row) return null;
  return {
    payload: row["fields"] ?? {},
    envelope: (row["envelope"] as AgentEnvelope) ?? { confidence: 0, warnings: [], reason: "" },
  };
}

export async function saveExtraction(
  context: RunContext,
  input: {
    documentId: string;
    segmentIndex: number;
    docType: string;
    payload: unknown;
    envelope: AgentEnvelope;
    agentRunId: string | null;
    sha256: string | null;
  },
): Promise<void> {
  await sql(
    `insert into ${table(context.schema, "extractions")}
      (document_id, segment_index, doc_type, pack_version, sha256, fields, confidences,
       locations, envelope, agent_run_id)
     values ($1, $2, $3, $4, $5, $6::jsonb, '{}'::jsonb, '{}'::jsonb, $7::jsonb, $8)
     on conflict (document_id, segment_index, pack_version) do update
       set fields = excluded.fields, envelope = excluded.envelope,
           agent_run_id = excluded.agent_run_id, doc_type = excluded.doc_type`,
    [
      input.documentId,
      input.segmentIndex,
      input.docType,
      context.pack.version,
      input.sha256,
      JSON.stringify(input.payload),
      JSON.stringify(input.envelope),
      input.agentRunId,
    ],
  );
}

export async function saveMatchDecision(
  context: RunContext,
  input: {
    recordId: string;
    kind: "vendor" | "ledger" | "item";
    input: Record<string, unknown>;
    match: MatchResult;
    agentRunId: string | null;
  },
): Promise<void> {
  await sql(
    `insert into ${table(context.schema, "match_decisions")}
      (record_id, kind, input, chosen, alternatives, confidence, reason, status, agent_run_id)
     values ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8, $9)`,
    [
      input.recordId,
      input.kind,
      JSON.stringify(input.input),
      input.match.vendor ? JSON.stringify(input.match.vendor) : null,
      JSON.stringify(input.match.alternatives),
      input.match.confidence,
      input.match.reason,
      input.match.status === "new_party" ? "new_party" : "suggested",
      input.agentRunId,
    ],
  );
}

export interface MappingRow {
  id: string;
  mapping: Record<string, unknown>;
  status: "proposed" | "confirmed";
}

export async function getMapping(
  schema: string,
  kind: "sheet_columns" | "vendor_ledger" | "field_default",
  scopeKey: string,
): Promise<MappingRow | null> {
  const row = await sqlOne<Record<string, unknown>>(
    `select id, mapping, status from ${table(schema, "mappings")}
      where kind = $1 and scope_key = $2 order by created_at desc limit 1`,
    [kind, scopeKey],
  );
  if (!row) return null;
  return {
    id: String(row["id"]),
    mapping: (row["mapping"] as Record<string, unknown>) ?? {},
    status: row["status"] as MappingRow["status"],
  };
}

export async function saveMapping(
  schema: string,
  input: {
    kind: "sheet_columns" | "vendor_ledger" | "field_default";
    scopeKey: string;
    mapping: Record<string, unknown>;
    status: "proposed" | "confirmed";
    source: string;
    confirmedBy?: string | null;
    evidenceCount?: number;
  },
): Promise<void> {
  await sql(
    `insert into ${table(schema, "mappings")}
      (kind, scope_key, mapping, status, source, evidence_count, confirmed_by, confirmed_at)
     values ($1, $2, $3::jsonb, $4, $5, $6, $7, case when $4 = 'confirmed' then now() else null end)
     on conflict (kind, scope_key) do update
       set mapping = excluded.mapping, status = excluded.status, source = excluded.source,
           evidence_count = greatest(mappings.evidence_count, excluded.evidence_count),
           confirmed_by = coalesce(excluded.confirmed_by, mappings.confirmed_by),
           confirmed_at = coalesce(excluded.confirmed_at, mappings.confirmed_at)`,
    [
      input.kind,
      input.scopeKey,
      JSON.stringify(input.mapping),
      input.status,
      input.source,
      input.evidenceCount ?? 1,
      input.confirmedBy ?? null,
    ],
  );
}

export interface MasterRow {
  id: string;
  name: string;
  gstin: string | null;
  ledger: string | null;
}

export async function listMasters(
  schema: string,
  kind: "vendor" | "ledger" | "item",
): Promise<MasterRow[]> {
  const rows = await sql<Record<string, unknown>>(
    `select id, name, gstin, ledger from ${table(schema, "masters")} where kind = $1 order by name asc`,
    [kind],
  );
  return rows.map((row) => ({
    id: String(row["id"]),
    name: String(row["name"]),
    gstin: row["gstin"] ? String(row["gstin"]) : null,
    ledger: row["ledger"] ? String(row["ledger"]) : null,
  }));
}

export async function ensureVendorMaster(
  schema: string,
  vendor: { name: string; gstin: string | null; ledger: string | null },
): Promise<void> {
  await sql(
    `insert into ${table(schema, "masters")} (kind, name, gstin, ledger, source)
     values ('vendor', $1, $2, $3, 'history')
     on conflict (kind, name) do update
       set gstin = coalesce(masters.gstin, excluded.gstin),
           ledger = coalesce(masters.ledger, excluded.ledger)`,
    [vendor.name, vendor.gstin, vendor.ledger],
  );
}

export async function confirmedVendorLedgers(schema: string): Promise<Record<string, string>> {
  const rows = await sql<Record<string, unknown>>(
    `select scope_key, mapping from ${table(schema, "mappings")}
      where kind = 'vendor_ledger' and status = 'confirmed'`,
  );
  const result: Record<string, string> = {};
  for (const row of rows) {
    const mapping = row["mapping"] as Record<string, unknown> | null;
    const ledger = mapping?.["ledger"];
    if (typeof ledger === "string" && ledger.trim()) result[String(row["scope_key"])] = ledger;
  }
  return result;
}

export async function confirmedFieldDefaults(
  schema: string,
  vendorKey: string,
): Promise<Record<string, string>> {
  const mapping = await getMapping(schema, "field_default", vendorKey);
  if (!mapping || mapping.status !== "confirmed") return {};
  const values = mapping.mapping["values"];
  if (!values || typeof values !== "object") return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

export interface CorrectionGroup {
  vendorKey: string;
  field: string;
  newValue: string;
  count: number;
  example: string;
  docType: string | null;
}

export async function correctionGroups(schema: string, days = 30): Promise<CorrectionGroup[]> {
  const rows = await sql<Record<string, unknown>>(
    `select coalesce(nullif(vendor_key, ''), 'unknown') as vendor_key, field,
            new_value, count(*)::int as n, max(doc_type) as doc_type
       from ${table(schema, "corrections")}
      where one_off = false
        and created_at >= now() - ($1 || ' days')::interval
        and coalesce(new_value, '') <> ''
      group by 1, 2, 3
      having count(*) >= 2
      order by n desc, field asc
      limit 80`,
    [String(days)],
  );
  return rows.map((row) => ({
    vendorKey: String(row["vendor_key"]),
    field: String(row["field"]),
    newValue: String(row["new_value"]),
    count: Number(row["n"] ?? 0),
    example: `${String(row["vendor_key"])} · ${String(row["field"])} → ${String(row["new_value"])}`,
    docType: row["doc_type"] ? String(row["doc_type"]) : null,
  }));
}

export async function saveRuleProposal(schema: string, rule: CuratorRule): Promise<void> {
  const existing = await sqlOne<{ id: string }>(
    `select id from ${table(schema, "rule_proposals")}
      where status = 'proposed' and rule->>'kind' = $1 and rule->>'scope' = $2
        and rule->>'field' = $3 and rule->>'value' = $4
      limit 1`,
    [rule.kind, rule.scope, rule.field, rule.value],
  );
  if (existing) {
    await sql(
      `update ${table(schema, "rule_proposals")}
          set evidence_count = $2, example = $3, rule = $4::jsonb
        where id = $1`,
      [existing.id, rule.evidenceCount, rule.example, JSON.stringify(rule)],
    );
    return;
  }
  await sql(
    `insert into ${table(schema, "rule_proposals")} (rule, evidence_count, example, status)
     values ($1::jsonb, $2, $3, 'proposed')`,
    [JSON.stringify(rule), rule.evidenceCount, rule.example],
  );
}

export interface RuleProposalRow {
  id: string;
  rule: CuratorRule;
  evidenceCount: number;
  example: string | null;
  status: string;
  createdAt: string;
}

export async function listRuleProposals(schema: string): Promise<RuleProposalRow[]> {
  const rows = await sql<Record<string, unknown>>(
    `select id, rule, evidence_count, example, status, created_at
       from ${table(schema, "rule_proposals")}
      where status in ('proposed', 'confirmed', 'ignored')
      order by case status when 'proposed' then 0 else 1 end, evidence_count desc, created_at desc
      limit 50`,
  );
  return rows.map((row) => ({
    id: String(row["id"]),
    rule: row["rule"] as CuratorRule,
    evidenceCount: Number(row["evidence_count"] ?? 0),
    example: row["example"] ? String(row["example"]) : null,
    status: String(row["status"]),
    createdAt: new Date(String(row["created_at"])).toISOString(),
  }));
}

export async function reviewRuleProposal(
  schema: string,
  proposalId: string,
  userId: string,
  decision: "confirmed" | "ignored",
): Promise<RuleProposalRow | null> {
  const row = await sqlOne<Record<string, unknown>>(
    `update ${table(schema, "rule_proposals")}
        set status = $2, reviewed_by = $3, reviewed_at = now()
      where id = $1 returning *`,
    [proposalId, decision, userId],
  );
  if (!row) return null;
  return {
    id: String(row["id"]),
    rule: row["rule"] as CuratorRule,
    evidenceCount: Number(row["evidence_count"] ?? 0),
    example: row["example"] ? String(row["example"]) : null,
    status: String(row["status"]),
    createdAt: new Date(String(row["created_at"])).toISOString(),
  };
}

export async function saveEmbedding(
  schema: string,
  input: {
    subjectType: string;
    subjectId: string;
    contentHash: string;
    embedding: number[];
    model: string;
  },
): Promise<void> {
  await sql(
    `insert into ${table(schema, "embeddings")}
      (subject_type, subject_id, content_hash, embedding, model)
     values ($1, $2, $3, $4::vector, $5)
     on conflict (subject_type, subject_id) do update
       set embedding = excluded.embedding, content_hash = excluded.content_hash,
           model = excluded.model`,
    [
      input.subjectType,
      input.subjectId,
      input.contentHash,
      JSON.stringify(input.embedding),
      input.model,
    ],
  );
}

export interface AgentRunRow {
  id: string;
  agent: string;
  mode: string;
  status: string;
  model: string | null;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  error: string | null;
  chatId: string | null;
  documentId: string | null;
  recordId: string | null;
  createdAt: string;
}

export async function listAgentRuns(schema: string, limit = 40): Promise<AgentRunRow[]> {
  const rows = await sql<Record<string, unknown>>(
    `select id, agent, mode, status, model, prompt_version, input_tokens, output_tokens,
            cost_usd, latency_ms, error, chat_id, document_id, record_id, created_at
       from ${table(schema, "agent_runs")}
      order by created_at desc limit $1`,
    [limit],
  );
  return rows.map((row) => ({
    id: String(row["id"]),
    agent: String(row["agent"]),
    mode: String(row["mode"]),
    status: String(row["status"]),
    model: row["model"] ? String(row["model"]) : null,
    promptVersion: String(row["prompt_version"]),
    inputTokens: Number(row["input_tokens"] ?? 0),
    outputTokens: Number(row["output_tokens"] ?? 0),
    costUsd: Number(row["cost_usd"] ?? 0),
    latencyMs: Number(row["latency_ms"] ?? 0),
    error: row["error"] ? String(row["error"]) : null,
    chatId: row["chat_id"] ? String(row["chat_id"]) : null,
    documentId: row["document_id"] ? String(row["document_id"]) : null,
    recordId: row["record_id"] ? String(row["record_id"]) : null,
    createdAt: new Date(String(row["created_at"])).toISOString(),
  }));
}

export interface AgentTotals {
  runs: number;
  modelRuns: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export async function agentTotals(schema: string, days = 30): Promise<AgentTotals> {
  const row = await sqlOne<Record<string, unknown>>(
    `select count(*)::int as runs,
            count(*) filter (where mode = 'model')::int as model_runs,
            count(*) filter (where status = 'failed')::int as failures,
            coalesce(sum(input_tokens), 0)::int as input_tokens,
            coalesce(sum(output_tokens), 0)::int as output_tokens,
            coalesce(sum(cost_usd), 0)::float as cost_usd
       from ${table(schema, "agent_runs")}
      where created_at >= now() - ($1 || ' days')::interval`,
    [String(days)],
  );
  return {
    runs: Number(row?.["runs"] ?? 0),
    modelRuns: Number(row?.["model_runs"] ?? 0),
    failures: Number(row?.["failures"] ?? 0),
    inputTokens: Number(row?.["input_tokens"] ?? 0),
    outputTokens: Number(row?.["output_tokens"] ?? 0),
    costUsd: Number(row?.["cost_usd"] ?? 0),
  };
}
