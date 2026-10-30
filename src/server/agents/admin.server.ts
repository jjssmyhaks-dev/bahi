import type { SessionUser } from "@/lib/types";
import { sql, table } from "../db.server";
import { getSheetConnection } from "../settings.server";
import { runCurator } from "./curator";
import { confirmMapper } from "./destination-mapper";
import {
  agentTotals,
  getMapping,
  listAgentRuns,
  listRuleProposals,
  reviewRuleProposal,
  saveMapping,
  type AgentRunRow,
  type AgentTotals,
  type RuleProposalRow,
} from "./store.server";
import { contextFromSession, type ColumnMapping, type CuratorRule } from "./types";

export interface SheetMappingView {
  connectionId: string;
  spreadsheetName: string;
  sheetName: string;
  status: "proposed" | "confirmed";
  columns: ColumnMapping[];
}

export interface AgentConsole {
  totals: AgentTotals;
  runs: AgentRunRow[];
  proposals: RuleProposalRow[];
  mapping: SheetMappingView | null;
}

function assertOwner(session: SessionUser) {
  if (session.role !== "owner") {
    throw new Error("Only the workspace owner can review what the agents learned.");
  }
}

function mappingColumns(mapping: Record<string, unknown>): ColumnMapping[] {
  const raw = Array.isArray(mapping["columns"]) ? mapping["columns"] : [];
  const columns: ColumnMapping[] = [];
  for (const entry of raw) {
    const item = entry as {
      column?: unknown;
      field?: unknown;
      fixedValue?: unknown;
      confidence?: unknown;
    };
    if (typeof item.column !== "string" || !item.column.trim()) continue;
    columns.push({
      column: item.column.trim(),
      field: typeof item.field === "string" ? item.field : null,
      fixedValue: typeof item.fixedValue === "string" ? item.fixedValue : null,
      confidence: typeof item.confidence === "number" ? item.confidence : 0.9,
    });
  }
  return columns;
}

export async function getAgentConsole(session: SessionUser): Promise<AgentConsole> {
  const [totals, runs, proposals, sheet] = await Promise.all([
    agentTotals(session.schema),
    listAgentRuns(session.schema, 40),
    listRuleProposals(session.schema),
    getSheetConnection(session),
  ]);

  let mapping: SheetMappingView | null = null;
  if (sheet) {
    const stored = await getMapping(session.schema, "sheet_columns", sheet.id);
    if (stored) {
      mapping = {
        connectionId: sheet.id,
        spreadsheetName: sheet.spreadsheet_name,
        sheetName: sheet.sheet_name,
        status: stored.status,
        columns: mappingColumns(stored.mapping),
      };
    }
  }

  return { totals, runs, proposals, mapping };
}

async function applyRule(session: SessionUser, rule: CuratorRule): Promise<void> {
  if (rule.kind === "vendor_ledger") {
    await saveMapping(session.schema, {
      kind: "vendor_ledger",
      scopeKey: rule.scope,
      mapping: { ledger: rule.value },
      status: "confirmed",
      source: "curator",
      confirmedBy: session.userId,
      evidenceCount: rule.evidenceCount,
    });
    return;
  }
  if (rule.kind === "field_default") {
    const existing = await getMapping(session.schema, "field_default", rule.scope);
    const values =
      existing?.mapping["values"] && typeof existing.mapping["values"] === "object"
        ? (existing.mapping["values"] as Record<string, unknown>)
        : {};
    await saveMapping(session.schema, {
      kind: "field_default",
      scopeKey: rule.scope,
      mapping: { values: { ...values, [rule.field]: rule.value } },
      status: "confirmed",
      source: "curator",
      confirmedBy: session.userId,
      evidenceCount: rule.evidenceCount,
    });
  }
}

export async function curateNow(session: SessionUser) {
  assertOwner(session);
  const outcome = await runCurator(contextFromSession(session));
  await sql(
    `insert into ${table(session.schema, "activity")} (user_id, action, detail) values ($1, 'learning.proposed', $2::jsonb)`,
    [
      session.userId,
      JSON.stringify({
        saved: outcome.saved,
        kinds: outcome.output.result.rules.map((rule) => rule.kind),
      }),
    ],
  );
  return {
    saved: outcome.saved,
    rules: outcome.output.result.rules,
    warnings: outcome.output.envelope.warnings,
    reason: outcome.output.envelope.reason,
  };
}

export async function reviewProposal(
  session: SessionUser,
  proposalId: string,
  decision: "confirmed" | "ignored",
): Promise<RuleProposalRow> {
  assertOwner(session);
  const updated = await reviewRuleProposal(session.schema, proposalId, session.userId, decision);
  if (!updated) throw new Error("That proposal no longer exists.");
  if (decision === "confirmed") await applyRule(session, updated.rule);
  await sql(
    `insert into ${table(session.schema, "activity")} (user_id, action, detail) values ($1, 'learning.reviewed', $2::jsonb)`,
    [session.userId, JSON.stringify({ proposalId, decision, rule: updated.rule })],
  );
  return updated;
}

export async function confirmSheetMapping(
  session: SessionUser,
  columns: ColumnMapping[],
): Promise<SheetMappingView> {
  assertOwner(session);
  const sheet = await getSheetConnection(session);
  if (!sheet) throw new Error("No Google Sheet is connected.");
  const cleaned = columns.filter((column) => column.column.trim());
  if (!cleaned.length) throw new Error("A mapping needs at least one column.");

  await confirmMapper(contextFromSession(session), sheet.id, {
    columns: cleaned,
    unmapped: cleaned
      .filter((column) => !column.field && !column.fixedValue)
      .map((column) => column.column),
  });
  await sql(
    `insert into ${table(session.schema, "activity")} (user_id, action, detail) values ($1, 'mapping.confirmed', $2::jsonb)`,
    [session.userId, JSON.stringify({ connectionId: sheet.id, columns: cleaned.length })],
  );
  return {
    connectionId: sheet.id,
    spreadsheetName: sheet.spreadsheet_name,
    sheetName: sheet.sheet_name,
    status: "confirmed",
    columns: cleaned,
  };
}
