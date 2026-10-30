import { createHash } from "node:crypto";

import { formatINR } from "@/lib/format";
import type {
  Destination,
  DocType,
  DocumentRow,
  FieldMap,
  RecordRow,
  RuleResult,
  SessionUser,
} from "@/lib/types";
import { sql, sqlOne, table } from "./db.server";
import { env } from "./env.server";
import { verifyGstin, type GstinLookup } from "./gstin.server";
import { extractFileText, storeDocument, type IncomingFile } from "./documents.server";
import { parseDate } from "./extraction";
import { approveRecord } from "./pipeline.server";
import { existingRecordKeys, getRecord, insertAssistantMessage } from "./repo.server";
import {
  buildExcelBase64,
  buildTallyVoucher,
  describeDestinationPayload,
  markExcelWritten,
  writeSheet,
} from "./posting.server";
import { evaluateDocument, summarizeRules } from "./rules";
import { routeRecord, type RouteDecision } from "./router";
import { runCategoriser, type BankLine } from "./agents/categoriser";
import { runClassifier as runClassifierAgent } from "./agents/classifier";
import { runCurator } from "./agents/curator";
import { runExplainer } from "./agents/explainer";
import { runExtractor, type ExtractorInput } from "./agents/extractor";
import { runMatcher } from "./agents/matcher";
import { hashEmbedding } from "./agents/embedding";
import { checkApprovalRights } from "./agents/tools/access";
import {
  reviewRuleProposal,
  saveEmbedding,
  saveMapping,
  type RuleProposalRow,
} from "./agents/store.server";
import type {
  AgentEnvelope,
  ClassifiedSegment,
  CuratorResult,
  ExtractedRecord,
  MatchResult,
  RuleExplanation,
  RunContext,
} from "./agents/types";
import { connectorFor } from "./connectors.server";
import {
  bridgeHealth,
  queueBridgeCommand,
  queueSyncMasters,
  type BridgeCommandResult,
} from "./bridge.server";

export type WorkflowErrorCode =
  "invalid" | "not_found" | "not_permitted" | "unavailable" | "failed";

export type WorkflowOutcome<T> =
  { ok: true; data: T } | { ok: false; code: WorkflowErrorCode; message: string };

function done<T>(data: T): WorkflowOutcome<T> {
  return { ok: true, data };
}

function stop<T>(code: WorkflowErrorCode, message: string): WorkflowOutcome<T> {
  return { ok: false, code, message };
}

function decode(file: IncomingFile): Buffer {
  return Buffer.from(
    file.base64.includes(",") ? file.base64.slice(file.base64.indexOf(",") + 1) : file.base64,
    "base64",
  );
}

const MONEY_FIELDS = new Set([
  "taxable_value",
  "cgst",
  "sgst",
  "igst",
  "round_off",
  "total",
  "debit",
  "credit",
  "balance",
]);

const DATE_FIELDS = new Set(["invoice_date"]);

// Intake ---------------------------------------------------------------------

export interface StoredUpload {
  documentId: string;
  filename: string;
  status: DocumentRow["status"];
  pageCount: number | null;
  error: string | null;
  duplicateOf: string | null;
}

export async function storeUpload(
  session: SessionUser,
  chatId: string,
  file: IncomingFile,
): Promise<WorkflowOutcome<StoredUpload>> {
  const stored = await storeDocument(session, chatId, file);
  return done({
    documentId: stored.document.id,
    filename: stored.document.filename,
    status: stored.document.status,
    pageCount: stored.pageCount,
    error: stored.error,
    duplicateOf: stored.duplicateOf,
  });
}

export interface FileCheck {
  filename: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  problems: string[];
}

export function checkFile(file: IncomingFile): WorkflowOutcome<FileCheck> {
  const buffer = decode(file);
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  const allowed = ["pdf", "xlsx", "xls", "csv", "tsv", "txt", "json"];
  const problems: string[] = [];
  if (buffer.length === 0) problems.push("The file is empty.");
  if (buffer.length > 10 * 1024 * 1024) problems.push("The file is larger than 10 MB.");
  if (!allowed.includes(extension) && !file.mimeType.startsWith("image/")) {
    problems.push(`.${extension || "unknown"} files are not supported.`);
  }
  return done({
    filename: file.name,
    mimeType: file.mimeType,
    extension,
    sizeBytes: buffer.length,
    problems,
  });
}

export interface ScanResult {
  scanned: boolean;
  clean: boolean | null;
  message: string;
}

/** No virus scanner is configured in this build; the result says so plainly. */
export function scanFile(_file: IncomingFile): WorkflowOutcome<ScanResult> {
  return stop(
    "unavailable",
    "No virus scanner is configured. Files are limited by type and size instead.",
  );
}

export function hashFile(
  file: IncomingFile,
): WorkflowOutcome<{ sha256: string; sizeBytes: number }> {
  const buffer = decode(file);
  return done({
    sha256: createHash("sha256").update(buffer).digest("hex"),
    sizeBytes: buffer.length,
  });
}

export async function checkDuplicateByHash(
  session: SessionUser,
  sha256: string,
): Promise<
  WorkflowOutcome<{ duplicate: { id: string; filename: string; createdAt: string } | null }>
> {
  const row = await sqlOne<{ id: string; filename: string; created_at: Date }>(
    `select id, filename, created_at from ${table(session.schema, "documents")}
      where sha256 = $1 and status <> 'failed' order by created_at asc limit 1`,
    [sha256],
  );
  return done({
    duplicate: row
      ? { id: row.id, filename: row.filename, createdAt: new Date(row.created_at).toISOString() }
      : null,
  });
}

export async function splitPdfPages(
  file: IncomingFile,
): Promise<WorkflowOutcome<{ pageCount: number; pages: string[]; imagesAvailable: false }>> {
  const extracted = await extractFileText(decode(file), file.mimeType, file.name);
  if (extracted.error) return stop("failed", extracted.error);
  const pages = extracted.text.split("\f").map((page) => page.trim());
  return done({
    pageCount: extracted.pageCount ?? pages.length,
    pages,
    imagesAvailable: false,
  });
}

// Pipeline -------------------------------------------------------------------

export interface ClassifierStepResult {
  segments: ClassifiedSegment[];
  envelope: AgentEnvelope;
}

export async function runClassifierStep(
  context: RunContext,
  input: { filename: string; text: string },
): Promise<WorkflowOutcome<ClassifierStepResult>> {
  const result = await runClassifierAgent(context, input);
  return done({ segments: result.segments, envelope: result.output.envelope });
}

export interface ExtractionStepResult {
  results: ExtractedRecord[];
  envelope: AgentEnvelope;
}

export async function runExtractionStep(
  context: RunContext,
  input: ExtractorInput,
): Promise<WorkflowOutcome<ExtractionStepResult>> {
  const output = await runExtractor(context, input);
  return done({ results: output.result.results, envelope: output.envelope });
}

/** Cleans printed values without guessing anything that is missing. */
export function normaliseRecord(fields: Record<string, unknown>): WorkflowOutcome<FieldMap> {
  const cleaned = { ...fields } as FieldMap;
  for (const [key, value] of Object.entries(cleaned)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (MONEY_FIELDS.has(key)) {
      const number = Number(trimmed.replace(/[₹,\s]/g, ""));
      if (trimmed && Number.isFinite(number)) cleaned[key] = number;
      continue;
    }
    if (key === "vendor_gstin") {
      cleaned[key] = trimmed.replace(/\s+/g, "").toUpperCase();
      continue;
    }
    if (DATE_FIELDS.has(key)) {
      const date = trimmed ? parseDate(trimmed) : undefined;
      cleaned[key] = date ?? trimmed;
      continue;
    }
    cleaned[key] = trimmed;
  }
  return done(cleaned);
}

export async function runMasterMatching(
  context: RunContext,
  fields: Pick<FieldMap, "vendor_name" | "vendor_gstin">,
): Promise<WorkflowOutcome<MatchResult>> {
  const output = await runMatcher(context, fields);
  return done(output.result);
}

export async function runBankCategoriserStep(context: RunContext, lines: BankLine[]) {
  const { loadCategoriserInput } = await import("./agents/categoriser");
  const input = await loadCategoriserInput(context, lines);
  const output = await runCategoriser(context, input);
  return done({ lines: output.result.lines, envelope: output.envelope });
}

export async function runValidationRules(
  session: SessionUser,
  input: {
    docType: DocType;
    fields: FieldMap;
    confidences: Record<string, number>;
  },
): Promise<WorkflowOutcome<{ rules: RuleResult[]; failed: number; warned: number }>> {
  const keys = await existingRecordKeys(session.schema);
  const rules = evaluateDocument({
    docType: input.docType,
    fields: input.fields,
    confidences: input.confidences,
    settings: session.settings,
    existing: keys,
  });
  const summary = summarizeRules(rules);
  return done({ rules, failed: summary.failed.length, warned: summary.warned.length });
}

export async function runValidationExplainer(
  context: RunContext,
  input: { docType: string; rules: RuleResult[]; fields: FieldMap },
): Promise<WorkflowOutcome<RuleExplanation[]>> {
  const output = await runExplainer(context, input);
  return done(output?.result.explanations ?? []);
}

export async function checkDuplicateByContent(
  session: SessionUser,
  input: { docType: DocType; fields: FieldMap },
): Promise<WorkflowOutcome<{ duplicate: { id: string; title: string; status: string } | null }>> {
  const vendor = String(input.fields.vendor_name ?? "").trim();
  const number = String(input.fields.invoice_number ?? "").trim();
  if (!vendor || !number) return done({ duplicate: null });
  const row = await sqlOne<{ id: string; title: string; status: string }>(
    `select id, title, status from ${table(session.schema, "records")}
      where doc_type = $1
        and lower(coalesce(fields->>'vendor_name', '')) = lower($2)
        and lower(coalesce(fields->>'invoice_number', '')) = lower($3)
      limit 1`,
    [input.docType, vendor, number],
  );
  return done({ duplicate: row ?? null });
}

export async function routeRecordStep(
  session: SessionUser,
  input: {
    destination: Destination;
    overallConfidence: number;
    rules: RuleResult[];
    amountMinor: number;
  },
): Promise<WorkflowOutcome<RouteDecision>> {
  const postedToday = await sqlOne<{ n: number }>(
    `select count(*)::int as n from ${table(session.schema, "records")}
      where posted_at >= current_date and status in ('posted', 'written')`,
  );
  return done(
    routeRecord({
      destination: input.destination,
      overallConfidence: input.overallConfidence,
      rules: input.rules,
      amountMinor: input.amountMinor,
      settings: session.settings,
      autonomyMode: session.autonomyMode,
      autonomyStage: session.autonomyStage,
      shadowMode: session.shadowMode,
      killSwitch: session.killSwitch,
      postedToday: Number(postedToday?.n ?? 0),
      permissionLevel: session.permissionLevel,
      ceilingMinor: session.settings.permissions.ceilingMinor,
    }),
  );
}

export async function createReviewItem(
  session: SessionUser,
  recordId: string,
): Promise<WorkflowOutcome<{ recordId: string; chatId: string | null }>> {
  const record = await getRecord(session.schema, recordId);
  if (!record) return stop("not_found", "That record is not in this workspace.");
  if (!record.chatId) return done({ recordId, chatId: null });
  const failed = record.validation.filter((rule) => rule.outcome === "fail");
  const content = failed.length
    ? `${record.title} is waiting for a person. ${failed[0]?.message ?? "A check failed."}`
    : `${record.title} is waiting for a person. ${formatINR(record.amountMinor)}.`;
  await insertAssistantMessage(session.schema, record.chatId, content, {
    kind: "upload_result",
    recordIds: [record.id],
  });
  return done({ recordId, chatId: record.chatId });
}

export async function waitForApproval(
  session: SessionUser,
  recordId: string,
  timeoutMs = 60_000,
): Promise<
  WorkflowOutcome<
    { status: RecordRow["status"]; waitedMs: number } | { status: "timeout"; waitedMs: number }
  >
> {
  const started = Date.now();
  const interval = 2_000;
  const deadline = started + Math.min(Math.max(timeoutMs, interval), 120_000);
  while (Date.now() <= deadline) {
    const record = await getRecord(session.schema, recordId);
    if (!record) return stop("not_found", "That record is not in this workspace.");
    if (record.status !== "pending_review" && record.status !== "held") {
      return done({ status: record.status, waitedMs: Date.now() - started });
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return done({ status: "timeout", waitedMs: Date.now() - started });
}

// External lookups -----------------------------------------------------------

export type { GstinLookup } from "./gstin.server";
export { gstinConfigured } from "./gstin.server";

export async function lookupGstin(gstin: string): Promise<WorkflowOutcome<GstinLookup>> {
  const result = await verifyGstin(gstin);
  return result.ok ? done(result.data) : stop("failed", result.message);
}

export async function refreshMasterData(
  session: SessionUser,
): Promise<WorkflowOutcome<{ vendors: number; ledgers: number; items: number; source: string }>> {
  const bridge = await bridgeHealth(session);
  if (bridge.online > 0) {
    const queued = await queueSyncMasters(session);
    if (queued.queued) {
      const rows = await sql<{ kind: string; n: number }>(
        `select kind, count(*)::int as n from ${table(session.schema, "masters")} group by kind`,
      );
      const counts = Object.fromEntries(rows.map((row) => [row.kind, Number(row.n)]));
      return done({
        vendors: counts["vendor"] ?? 0,
        ledgers: counts["ledger"] ?? 0,
        items: counts["item"] ?? 0,
        source: "Tally bridge sync queued · current counts until the agent replies",
      });
    }
  }
  const rows = await sql<{ kind: string; n: number }>(
    `select kind, count(*)::int as n from ${table(session.schema, "masters")} group by kind`,
  );
  const counts = Object.fromEntries(rows.map((row) => [row.kind, Number(row.n)]));
  return done({
    vendors: counts["vendor"] ?? 0,
    ledgers: counts["ledger"] ?? 0,
    items: counts["item"] ?? 0,
    source: "tenant masters (no bridge agent is polling)",
  });
}

// Destination ----------------------------------------------------------------

export function mapToDestination(record: RecordRow, company: string) {
  return done(describeDestinationPayload(record, company));
}

export function buildTallyVoucherStep(record: RecordRow, company: string) {
  return done(buildTallyVoucher(record, company));
}

export function queueBridgeCommandStep(
  input: Parameters<typeof queueBridgeCommand>[0],
): WorkflowOutcome<BridgeCommandResult> {
  return done(queueBridgeCommand(input));
}

export async function writeToExcel(
  session: SessionUser,
  recordId: string,
): Promise<WorkflowOutcome<{ externalRef: string; note: string; workbookBase64: string }>> {
  const record = await getRecord(session.schema, recordId);
  if (!record) return stop("not_found", "That record is not in this workspace.");
  const result = await markExcelWritten(session.schema, record);
  const workbook = await buildExcelBase64([record]);
  return done({ externalRef: result.externalRef, note: result.note, workbookBase64: workbook });
}

export async function writeToGoogleSheet(
  session: SessionUser,
  recordId: string,
): Promise<WorkflowOutcome<{ externalRef: string; note: string }>> {
  const record = await getRecord(session.schema, recordId);
  if (!record) return stop("not_found", "That record is not in this workspace.");
  try {
    const result = await writeSheet(session.schema, record);
    return done({ externalRef: result.externalRef, note: result.note });
  } catch (error) {
    return stop("unavailable", error instanceof Error ? error.message : "The sheet write failed.");
  }
}

export async function confirmWrite(
  session: SessionUser,
  recordId: string,
  destination: Destination,
): Promise<WorkflowOutcome<{ confirmed: boolean; detail: string }>> {
  const row = await sqlOne<{ status: string; external_ref: string | null }>(
    `select status, external_ref from ${table(session.schema, "posts")}
      where record_id = $1 and destination = $2 order by created_at desc limit 1`,
    [recordId, destination],
  );
  if (!row)
    return done({ confirmed: false, detail: "No write was recorded for this destination." });
  return done({
    confirmed: row.status === "posted",
    detail: row.external_ref
      ? `Destination reference ${row.external_ref}.`
      : `Write is ${row.status}.`,
  });
}

export async function rollbackWrite(
  session: SessionUser,
  recordId: string,
  destination: Destination,
): Promise<WorkflowOutcome<{ rolledBack: boolean; message: string }>> {
  if (destination !== "tally") {
    return stop(
      "unavailable",
      "Only Tally vouchers can be reversed from Bahi. Undo the sheet or workbook entry at the destination.",
    );
  }
  try {
    return await connectorFor("tally").rollback(session, recordId, "");
  } catch (error) {
    return stop(
      "unavailable",
      error instanceof Error ? error.message : "The Tally voucher could not be reversed.",
    );
  }
}

// Approval -------------------------------------------------------------------

export async function checkApprovalRightsStep(session: SessionUser, recordId: string) {
  const record = await getRecord(session.schema, recordId);
  if (!record) return stop("not_found", "That record is not in this workspace.");
  const rights = checkApprovalRights(session, record);
  if ("ok" in rights) return stop("not_permitted", rights.error.message);
  return done({ allowed: true });
}

export async function recordApproval(
  session: SessionUser,
  recordId: string,
  note?: string,
): Promise<WorkflowOutcome<RecordRow>> {
  try {
    const record = await approveRecord(session, recordId, note ? { note } : {});
    return done(record);
  } catch (error) {
    return stop("failed", error instanceof Error ? error.message : "The approval failed.");
  }
}

export async function storeConfirmedMapping(
  session: SessionUser,
  scopeKey: string,
  columns: { column: string; field: string | null; fixedValue?: string | null }[],
): Promise<WorkflowOutcome<{ scopeKey: string }>> {
  await saveMapping(session.schema, {
    kind: "sheet_columns",
    scopeKey,
    mapping: {
      columns: columns.map((column) => ({
        column: column.column,
        field: column.field,
        fixedValue: column.fixedValue ?? null,
        confidence: 0.99,
      })),
    },
    status: "confirmed",
    source: "user",
    confirmedBy: session.userId,
  });
  return done({ scopeKey });
}

// Learning -------------------------------------------------------------------

export async function saveCorrection(
  session: SessionUser,
  input: {
    recordId: string;
    field: string;
    oldValue: string;
    newValue: string;
    oneOff?: boolean;
    reason?: string;
  },
): Promise<WorkflowOutcome<{ saved: true }>> {
  const record = await getRecord(session.schema, input.recordId);
  if (!record) return stop("not_found", "That record is not in this workspace.");
  await sql(
    `insert into ${table(session.schema, "corrections")}
      (record_id, document_id, doc_type, vendor_key, field, old_value, new_value, user_id, reason, one_off)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      record.id,
      record.documentId,
      record.docType,
      record.fields.vendor_gstin ?? record.fields.vendor_name ?? null,
      input.field,
      input.oldValue,
      input.newValue,
      session.userId,
      input.reason ?? null,
      input.oneOff ?? false,
    ],
  );
  return done({ saved: true });
}

export async function embedDocument(
  session: SessionUser,
  input: { documentId: string; text: string; model?: string },
): Promise<WorkflowOutcome<{ embeddingStored: true }>> {
  const clean = input.text.replace(/\s+/g, " ").trim().slice(0, 8_000);
  if (!clean) return stop("invalid", "There is no text to embed.");
  await saveEmbedding(session.schema, {
    subjectType: "document",
    subjectId: input.documentId,
    contentHash: createHash("sha256").update(clean).digest("hex"),
    embedding: hashEmbedding(clean),
    model: input.model ?? "bahi-hash-256",
  });
  return done({ embeddingStored: true });
}

export async function runLearningCurator(
  context: RunContext,
): Promise<WorkflowOutcome<{ rules: CuratorResult["rules"]; saved: number }>> {
  const outcome = await runCurator(context);
  return done({ rules: outcome.output.result.rules, saved: outcome.saved });
}

export async function activateRule(
  session: SessionUser,
  proposalId: string,
): Promise<WorkflowOutcome<RuleProposalRow>> {
  if (session.role === "viewer") {
    return stop("not_permitted", "Your role cannot activate a rule.");
  }
  const row = await reviewRuleProposal(session.schema, proposalId, session.userId, "confirmed");
  if (!row) return stop("not_found", "That rule proposal was not found.");
  return done(row);
}

// Notifications and audit ----------------------------------------------------

export async function pushChatEvent(
  session: SessionUser,
  chatId: string,
  content: string,
  meta: Record<string, unknown> = { kind: "intent_result" },
): Promise<WorkflowOutcome<{ messageId: string }>> {
  const messageId = await insertAssistantMessage(session.schema, chatId, content, meta);
  return done({ messageId: String(messageId) });
}

export function sendNotification(
  _session: SessionUser,
  _channel: "email" | "whatsapp",
  _to: string,
  _content: string,
): WorkflowOutcome<{ sent: false; message: string }> {
  return stop("unavailable", "Email and WhatsApp providers are not configured in this build.");
}

export async function writeAuditEntry(
  session: SessionUser,
  input: {
    action: string;
    recordId?: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<WorkflowOutcome<{ auditId: string }>> {
  const row = await sqlOne<{ id: string }>(
    `insert into ${table(session.schema, "activity")} (user_id, record_id, action, detail)
     values ($1, $2, $3, $4::jsonb) returning id`,
    [session.userId, input.recordId ?? null, input.action, JSON.stringify(input.detail ?? {})],
  );
  return done({ auditId: String(row?.id ?? "") });
}

export async function recordUsage(
  session: SessionUser,
): Promise<WorkflowOutcome<{ periodStart: string; vouchers: number; bankStatements: number }>> {
  const periodStart = session.settings.gst.fyStart;
  const rows = await sql<{ doc_type: string; n: number }>(
    `select doc_type, count(*)::int as n from ${table(session.schema, "records")}
      where status in ('posted', 'written') and posted_at >= $1::date
      group by doc_type`,
    [periodStart],
  );
  const counts = Object.fromEntries(rows.map((row) => [row.doc_type, Number(row.n)]));
  const vouchers = rows.reduce((sum, row) => sum + Number(row.n), 0);
  return done({
    periodStart,
    vouchers,
    bankStatements: counts["bank_statement"] ?? 0,
  });
}

/** Names exactly as the build specification lists them. Agents never call these. */
export const WORKFLOW_FUNCTIONS = {
  store_upload: storeUpload,
  check_file: checkFile,
  scan_file: scanFile,
  hash_file: hashFile,
  check_duplicate_by_hash: checkDuplicateByHash,
  split_pdf_pages: splitPdfPages,
  run_classifier: runClassifierStep,
  run_extraction: runExtractionStep,
  normalise_record: normaliseRecord,
  run_master_matching: runMasterMatching,
  run_bank_categoriser: runBankCategoriserStep,
  run_validation_rules: runValidationRules,
  run_validation_explainer: runValidationExplainer,
  check_duplicate_by_content: checkDuplicateByContent,
  route_record: routeRecordStep,
  create_review_item: createReviewItem,
  wait_for_approval: waitForApproval,
  lookup_gstin: lookupGstin,
  refresh_master_data: refreshMasterData,
  map_to_destination: mapToDestination,
  build_tally_voucher: buildTallyVoucherStep,
  queue_bridge_command: queueBridgeCommandStep,
  write_to_excel: writeToExcel,
  write_to_google_sheet: writeToGoogleSheet,
  confirm_write: confirmWrite,
  rollback_write: rollbackWrite,
  check_approval_rights: checkApprovalRightsStep,
  record_approval: recordApproval,
  store_confirmed_mapping: storeConfirmedMapping,
  save_correction: saveCorrection,
  embed_document: embedDocument,
  run_learning_curator: runLearningCurator,
  activate_rule: activateRule,
  push_chat_event: pushChatEvent,
  send_notification: sendNotification,
  write_audit_entry: writeAuditEntry,
  record_usage: recordUsage,
} as const;

export type WorkflowFunctionName = keyof typeof WORKFLOW_FUNCTIONS;
