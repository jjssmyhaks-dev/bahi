import { z } from "zod";

import { DESTINATION_LABELS, formatINR } from "@/lib/format";
import type { FieldMap, FieldValue, RecordRow } from "@/lib/types";
import { sql, sqlOne, table } from "../../db.server";
import { getRecord, listQueue, listRecordsForChat } from "../../repo.server";
import { RULE_NEXT_STEPS } from "../pack";
import {
  checkApprovalRights,
  isOpen,
  loadRecord,
  recordSummary,
  requireOwner,
  requireWriter,
} from "./access";
import { defineTool, fail, ok } from "./types";

const DESTINATION = z.enum(["tally", "excel", "google_sheets"]);

const EDITABLE_FIELDS = new Set([
  "vendor_name",
  "vendor_gstin",
  "invoice_number",
  "invoice_date",
  "place_of_supply",
  "taxable_value",
  "cgst",
  "sgst",
  "igst",
  "total",
  "tds_section",
  "narration",
]);

const MONEY_FIELDS = new Set([
  "taxable_value",
  "cgst",
  "sgst",
  "igst",
  "total",
  "round_off",
  "debit",
  "credit",
  "balance",
]);

function coerceField(field: string, value: string): FieldValue {
  if (MONEY_FIELDS.has(field)) {
    const number = Number(value.replace(/[₹,\s]/g, ""));
    return Number.isFinite(number) ? number : value;
  }
  if (field === "vendor_gstin") return value.replace(/\s+/g, "").toUpperCase();
  return value;
}

function ambiguous(candidates: RecordRow[]) {
  return fail(
    "ambiguous",
    "More than one record matches. Ask the user which one they mean, then call the tool again with a single record.",
    candidates.map((record) => ({ id: record.id, label: record.title })),
  );
}

export function resolveTargetIds(
  recordIds: string[],
  groupApproval: boolean,
  records: RecordRow[],
) {
  if (recordIds.length > 1 && !groupApproval) return ambiguous(records);
  return null;
}

export const startProcessingTool = defineTool({
  name: "start_processing",
  description:
    "Start reading and checking uploaded documents that are waiting in this conversation. Use the document ids from the attachment context. Returns a batch id and how many documents were processed.",
  kind: "write",
  agents: ["chat_orchestrator"],
  schema: z.object({
    document_ids: z.array(z.string().uuid()).min(1).max(20),
    destination: DESTINATION.optional(),
    options: z.record(z.string()).optional(),
    idempotency_key: z.string().min(1).max(120).optional(),
  }),
  run: async (args, context) => {
    const session = requireWriter(context.session, "start processing");
    if ("ok" in session) return session;
    const chatId = context.run.chatId;
    if (!chatId) return fail("unavailable", "There is no conversation to process documents in.");

    const rows = await sql<{ id: string; filename: string; extracted_text: string | null }>(
      `select id, filename, extracted_text from ${table(session.schema, "documents")}
        where chat_id = $1 and id = any($2::uuid[])`,
      [chatId, args.document_ids],
    );
    if (!rows.length)
      return fail("not_found", "None of those documents belong to this conversation.");

    let processed = 0;
    let records = 0;
    const failed: { id: string; reason: string }[] = [];
    for (const row of rows) {
      if (!row.extracted_text?.trim()) {
        failed.push({ id: row.id, reason: "No readable text in this file." });
        continue;
      }
      const document = await sqlOne<Record<string, unknown>>(
        `select *, chat_id from ${table(session.schema, "documents")} where id = $1`,
        [row.id],
      );
      if (!document) continue;
      const { mapDocument } = await import("../../repo.server");
      const mapped = mapDocument(document);
      if (!mapped) continue;
      const { processDocumentText } = await import("../pipeline.server");
      const outcome = await processDocumentText({
        session,
        chatId,
        document: mapped,
        text: row.extracted_text,
        filename: row.filename,
        ...(args.destination ? { destinationOverride: args.destination } : {}),
      });
      processed += 1;
      records += outcome.records.length;
    }

    return ok(
      {
        batchId: chatId,
        processed,
        records,
        failed,
      },
      `${processed} document${processed === 1 ? "" : "s"} processed · ${records} record${records === 1 ? "" : "s"}`,
    );
  },
});

export const getBatchStatusTool = defineTool({
  name: "get_batch_status",
  description:
    "Return progress for the current batch (the conversation): how many documents and records are queued, waiting, written or failed.",
  kind: "read",
  agents: ["chat_orchestrator"],
  schema: z.object({
    batch_id: z.string().uuid().optional(),
  }),
  run: async (args, context) => {
    const chatId = args.batch_id ?? context.run.chatId;
    if (!chatId) return fail("not_found", "There is no batch in this conversation yet.");
    const records = await listRecordsForChat(context.run.schema, chatId);
    const counts = records.reduce<Record<string, number>>((acc, record) => {
      acc[record.status] = (acc[record.status] ?? 0) + 1;
      return acc;
    }, {});
    const documents = await sqlOne<{ n: number }>(
      `select count(*)::int as n from ${table(context.run.schema, "documents")} where chat_id = $1`,
      [chatId],
    );
    return ok(
      { batchId: chatId, documents: Number(documents?.n ?? 0), records: counts },
      `${records.length} record${records.length === 1 ? "" : "s"} in this conversation`,
    );
  },
});

export const getDocumentStatusTool = defineTool({
  name: "get_document_status",
  description: "Return the state and a short summary for one uploaded document.",
  kind: "read",
  agents: ["chat_orchestrator"],
  schema: z.object({ document_id: z.string().uuid() }),
  run: async (args, context) => {
    const row = await sqlOne<{
      id: string;
      filename: string;
      status: string;
      doc_type: string | null;
      error: string | null;
      page_count: number | null;
    }>(
      `select id, filename, status, doc_type, error, page_count
         from ${table(context.run.schema, "documents")} where id = $1`,
      [args.document_id],
    );
    if (!row) return fail("not_found", "That document is not in this workspace.");
    return ok(
      {
        id: row.id,
        filename: row.filename,
        status: row.status,
        docType: row.doc_type,
        pageCount: row.page_count,
        error: row.error,
      },
      `${row.filename} · ${row.status}`,
    );
  },
});

export const getRecordCardTool = defineTool({
  name: "get_record_card",
  description:
    "Build the result card for one record: its key fields, confidences, failed and warned checks, amount and destination.",
  kind: "read",
  agents: ["chat_orchestrator"],
  schema: z.object({ record_id: z.string().uuid() }),
  run: async (args, context) => {
    const record = await getRecord(context.run.schema, args.record_id);
    if (!record) return fail("not_found", "That record is not in this workspace.");
    const fields = Object.fromEntries(
      Object.entries(record.fields)
        .filter(([, value]) => value !== null && value !== undefined && !Array.isArray(value))
        .slice(0, 20),
    );
    const flagged = record.validation.filter(
      (rule) => rule.outcome === "fail" || rule.outcome === "warn",
    );
    return ok(
      {
        ...recordSummary(record),
        fields,
        confidences: record.confidences,
        lineItemCount: Array.isArray(record.fields.line_items)
          ? record.fields.line_items.length
          : 0,
        flagged: flagged.map((rule) => ({
          id: rule.id,
          label: rule.label,
          outcome: rule.outcome,
          message: rule.message,
        })),
        reason: record.reason,
      },
      `${record.title} · ${formatINR(record.amountMinor)} · ${record.status}`,
    );
  },
});

export const listNeedsAttentionTool = defineTool({
  name: "list_needs_attention",
  description:
    "List records waiting for a person. Optionally filter by vendor name or destination.",
  kind: "read",
  agents: ["chat_orchestrator"],
  schema: z.object({
    vendor: z.string().max(120).optional(),
    destination: DESTINATION.optional(),
  }),
  run: async (args, context) => {
    const records = await listQueue(context.run.schema, {
      ...(args.destination ? { destination: args.destination } : {}),
    });
    const needle = args.vendor?.toLowerCase().trim();
    const filtered = needle
      ? records.filter((record) =>
          `${record.title} ${String(record.fields.vendor_name ?? "")}`
            .toLowerCase()
            .includes(needle),
        )
      : records;
    const items = filtered.slice(0, 20).map((record) => ({
      id: record.id,
      title: record.title,
      reason:
        record.validation.find((rule) => rule.outcome === "fail")?.message ??
        record.reason ??
        "Waiting for review.",
      amountMinor: record.amountMinor,
      status: record.status,
    }));
    return ok(
      { count: filtered.length, records: items },
      `${filtered.length} record${filtered.length === 1 ? "" : "s"} waiting`,
    );
  },
});

export const applyCorrectionTool = defineTool({
  name: "apply_correction",
  description:
    "Change one editable field on a record that is still waiting for review. Pass one_off when the user says this correction should not become a learning rule.",
  kind: "write",
  agents: ["chat_orchestrator"],
  schema: z.object({
    record_id: z.string().uuid(),
    field: z.string().min(1).max(80),
    value: z.string().min(1).max(500),
    one_off: z.boolean().optional(),
    idempotency_key: z.string().min(1).max(120).optional(),
  }),
  run: async (args, context) => {
    const session = requireWriter(context.session, "edit records");
    if ("ok" in session) return session;
    const record = await loadRecord(session.schema, args.record_id);
    if ("ok" in record) return record;
    if (!isOpen(record)) {
      return fail("not_permitted", "A record that is already written cannot be edited.");
    }
    if (!EDITABLE_FIELDS.has(args.field)) {
      return fail("invalid_arguments", `“${args.field}” is not an editable field.`);
    }
    const { saveRecordFields } = await import("../../pipeline.server");
    const updated = await saveRecordFields(
      session,
      record.id,
      { [args.field]: coerceField(args.field, args.value) } as FieldMap,
      { reason: "Corrected in the chat.", oneOff: args.one_off ?? false },
    );
    return ok(
      {
        ...recordSummary(updated),
        field: args.field,
        value: updated.fields[args.field],
        failedChecks: updated.validation.filter((rule) => rule.outcome === "fail").length,
      },
      `Updated ${args.field.replace(/_/g, " ")} on ${updated.title}`,
    );
  },
});

export const approveRecordsTool = defineTool({
  name: "approve_records",
  description:
    "Approve one record, or a group when the user clearly asked for a group approval, through the same approval service as the buttons. Refuses records the user may not approve.",
  kind: "write",
  agents: ["chat_orchestrator"],
  schema: z.object({
    record_ids: z.array(z.string().uuid()).min(1).max(20),
    note: z.string().max(400).optional(),
    group_approval: z.boolean().optional(),
    idempotency_key: z.string().min(1).max(120).optional(),
  }),
  run: async (args, context) => {
    const session = requireWriter(context.session, "approve records");
    if ("ok" in session) return session;
    const records: RecordRow[] = [];
    for (const id of args.record_ids) {
      const record = await loadRecord(session.schema, id);
      if ("ok" in record) {
        return fail("not_found", `A record in that list is not in this workspace.`);
      }
      records.push(record);
    }
    const ambiguity = resolveTargetIds(args.record_ids, args.group_approval ?? false, records);
    if (ambiguity) return ambiguity;

    const results = [];
    for (const record of records) {
      const rights = checkApprovalRights(session, record);
      if ("ok" in rights) {
        results.push({ id: record.id, outcome: "not_permitted", message: rights.error.message });
        continue;
      }
      try {
        const { approveRecord } = await import("../../pipeline.server");
        const updated = await approveRecord(session, record.id, {
          ...(args.note ? { note: args.note } : {}),
        });
        results.push({
          id: record.id,
          outcome:
            updated.status === "posted" || updated.status === "written" ? "approved" : "blocked",
          status: updated.status,
          destinationRef: updated.destinationRef,
          message:
            updated.status === "posted" || updated.status === "written"
              ? `Written to ${DESTINATION_LABELS[updated.destination]}${updated.destinationRef ? ` as ${updated.destinationRef}` : ""}.`
              : (updated.reason ?? "Still needs a look."),
        });
      } catch (error) {
        results.push({
          id: record.id,
          outcome: "failed",
          message: error instanceof Error ? error.message : "The approval failed.",
        });
      }
    }
    const approved = results.filter((result) => result.outcome === "approved").length;
    return ok({ results }, `${approved} of ${results.length} approved`);
  },
});

export const rejectRecordsTool = defineTool({
  name: "reject_records",
  description: "Reject one record or a group with a reason. Nothing is written to a destination.",
  kind: "write",
  agents: ["chat_orchestrator"],
  schema: z.object({
    record_ids: z.array(z.string().uuid()).min(1).max(20),
    reason: z.string().min(1).max(400),
    group_approval: z.boolean().optional(),
    idempotency_key: z.string().min(1).max(120).optional(),
  }),
  run: async (args, context) => {
    const session = requireWriter(context.session, "reject records");
    if ("ok" in session) return session;
    const records: RecordRow[] = [];
    for (const id of args.record_ids) {
      const record = await loadRecord(session.schema, id);
      if ("ok" in record)
        return fail("not_found", "A record in that list is not in this workspace.");
      if (!isOpen(record)) {
        return fail("not_permitted", `${record.title} is not waiting for review.`);
      }
      records.push(record);
    }
    const ambiguity = resolveTargetIds(args.record_ids, args.group_approval ?? false, records);
    if (ambiguity) return ambiguity;
    const { rejectRecord } = await import("../../pipeline.server");
    for (const record of records) await rejectRecord(session, record.id, args.reason);
    return ok(
      { recordIds: records.map((record) => record.id), reason: args.reason },
      `Rejected ${records.length} record${records.length === 1 ? "" : "s"}`,
    );
  },
});

export const holdRecordsTool = defineTool({
  name: "hold_records",
  description: "Put one record or a group on hold, for example to wait for a clearer document.",
  kind: "write",
  agents: ["chat_orchestrator"],
  schema: z.object({
    record_ids: z.array(z.string().uuid()).min(1).max(20),
    reason: z.string().max(400).optional(),
    group_approval: z.boolean().optional(),
    idempotency_key: z.string().min(1).max(120).optional(),
  }),
  run: async (args, context) => {
    const session = requireWriter(context.session, "hold records");
    if ("ok" in session) return session;
    const records: RecordRow[] = [];
    for (const id of args.record_ids) {
      const record = await loadRecord(session.schema, id);
      if ("ok" in record)
        return fail("not_found", "A record in that list is not in this workspace.");
      if (!isOpen(record)) {
        return fail("not_permitted", `${record.title} is not waiting for review.`);
      }
      records.push(record);
    }
    const ambiguity = resolveTargetIds(args.record_ids, args.group_approval ?? false, records);
    if (ambiguity) return ambiguity;
    const { holdRecord } = await import("../../pipeline.server");
    for (const record of records) {
      await holdRecord(session, record.id, args.reason ?? "Held from the chat.");
    }
    return ok(
      { recordIds: records.map((record) => record.id) },
      `Held ${records.length} record${records.length === 1 ? "" : "s"}`,
    );
  },
});

export const explainFlagTool = defineTool({
  name: "explain_flag",
  description:
    "Return the stored plain-language reasons and suggested next steps for why a record was flagged.",
  kind: "read",
  agents: ["chat_orchestrator"],
  schema: z.object({ record_id: z.string().uuid() }),
  run: async (args, context) => {
    const record = await getRecord(context.run.schema, args.record_id);
    if (!record) return fail("not_found", "That record is not in this workspace.");
    const explanations = record.envelope.explanations?.length
      ? record.envelope.explanations
      : record.validation
          .filter((rule) => rule.outcome === "fail" || rule.outcome === "warn")
          .map((rule) => ({
            ruleId: rule.id,
            outcome: rule.outcome as "warn" | "fail",
            reason: rule.message,
            nextStep: RULE_NEXT_STEPS[rule.id] ?? "Check the value against the source document.",
          }));
    return ok(
      { recordId: record.id, title: record.title, explanations },
      `${explanations.length} flagged check${explanations.length === 1 ? "" : "s"}`,
    );
  },
});

export const listDestinationsTool = defineTool({
  name: "list_destinations",
  description: "List the destinations available to this workspace and their health.",
  kind: "read",
  agents: ["chat_orchestrator"],
  schema: z.object({}),
  run: async (_args, context) => {
    const sheet = await sqlOne<{
      id: string;
      spreadsheet_name: string;
      sheet_name: string;
      status: string;
    }>(
      `select id, spreadsheet_name, sheet_name, status
         from ${table(context.run.schema, "sheet_connections")}
        where provider = 'google_sheets' order by created_at asc limit 1`,
    );
    const destinations = [
      {
        destination: "tally",
        label: DESTINATION_LABELS.tally,
        status: "bridge",
        detail: "Bahi builds a validated Tally voucher XML for the bridge agent.",
      },
      {
        destination: "excel",
        label: DESTINATION_LABELS.excel,
        status: "available",
        detail: "Workbook download from the record or the queue.",
      },
      {
        destination: "google_sheets",
        label: DESTINATION_LABELS.google_sheets,
        status: sheet?.status === "connected" ? "connected" : "needs_sign_in",
        detail: sheet
          ? `${sheet.spreadsheet_name} · ${sheet.sheet_name}`
          : "No sheet is connected yet.",
      },
    ];
    return ok({ destinations }, "Destination health");
  },
});

export const connectDestinationTool = defineTool({
  name: "connect_destination",
  description:
    "Start connecting a destination. Returns a sign-in link or setup instructions to show the user.",
  kind: "write",
  agents: ["chat_orchestrator"],
  schema: z.object({
    destination: DESTINATION,
    idempotency_key: z.string().min(1).max(120).optional(),
  }),
  run: async (args, context) => {
    const session = requireOwner(context.session, "connect a destination");
    if ("ok" in session) return session;
    if (args.destination === "google_sheets") {
      const sheet = await sqlOne<{ spreadsheet_name: string; sheet_name: string }>(
        `select spreadsheet_name, sheet_name from ${table(session.schema, "sheet_connections")}
          where provider = 'google_sheets' order by created_at asc limit 1`,
      );
      if (sheet) {
        return ok(
          {
            destination: args.destination,
            status: "connected",
            instructions: `${sheet.spreadsheet_name} · ${sheet.sheet_name} is connected in simulated mode.`,
          },
          "Google Sheets is connected",
        );
      }
      return fail(
        "unavailable",
        "Google sign-in is not configured in this build. Open Settings to create the sheet connection.",
      );
    }
    if (args.destination === "tally") {
      return ok(
        {
          destination: args.destination,
          status: "bridge",
          instructions:
            "Download the Tally voucher XML from a record and import it in TallyPrime. The bridge agent is not part of this build.",
        },
        "Tally bridge instructions",
      );
    }
    return ok(
      {
        destination: args.destination,
        status: "available",
        instructions: "Excel workbooks are generated on demand from a record or the review queue.",
      },
      "Excel is ready",
    );
  },
});

export const listSheetsTool = defineTool({
  name: "list_sheets",
  description: "List the spreadsheets or templates connected to this workspace.",
  kind: "read",
  agents: ["chat_orchestrator"],
  schema: z.object({}),
  run: async (_args, context) => {
    const rows = await sql<{
      id: string;
      provider: string;
      spreadsheet_name: string;
      sheet_name: string;
      status: string;
    }>(
      `select id, provider, spreadsheet_name, sheet_name, status
         from ${table(context.run.schema, "sheet_connections")} order by created_at asc`,
    );
    return ok(
      {
        sheets: rows.map((row) => ({
          id: row.id,
          provider: row.provider,
          spreadsheetName: row.spreadsheet_name,
          sheetName: row.sheet_name,
          status: row.status,
        })),
      },
      `${rows.length} sheet${rows.length === 1 ? "" : "s"} connected`,
    );
  },
});

export const findRecordsTool = defineTool({
  name: "find_records",
  description:
    "Find past records by vendor, date range, amount range or status, so the user can refer to an earlier bill.",
  kind: "read",
  agents: ["chat_orchestrator"],
  schema: z.object({
    vendor: z.string().max(120).optional(),
    date_from: z.string().max(20).optional(),
    date_to: z.string().max(20).optional(),
    min_amount: z.number().min(0).optional(),
    max_amount: z.number().min(0).optional(),
    status: z
      .enum(["pending_review", "held", "posted", "written", "rejected", "failed"])
      .optional(),
  }),
  run: async (args, context) => {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (args.vendor) {
      params.push(`%${args.vendor.toLowerCase()}%`);
      clauses.push(
        `(lower(coalesce(r.fields->>'vendor_name','')) like $${params.length} or lower(r.title) like $${params.length})`,
      );
    }
    if (args.date_from) {
      params.push(args.date_from);
      clauses.push(`coalesce(r.fields->>'invoice_date','') >= $${params.length}`);
    }
    if (args.date_to) {
      params.push(args.date_to);
      clauses.push(`coalesce(r.fields->>'invoice_date','') <= $${params.length}`);
    }
    if (args.min_amount !== undefined) {
      params.push(Math.round(args.min_amount * 100));
      clauses.push(`r.amount_minor >= $${params.length}`);
    }
    if (args.max_amount !== undefined) {
      params.push(Math.round(args.max_amount * 100));
      clauses.push(`r.amount_minor <= $${params.length}`);
    }
    if (args.status) {
      params.push(args.status);
      clauses.push(`r.status = $${params.length}`);
    }
    const rows = await sql<{
      id: string;
      title: string;
      status: string;
      amount_minor: number;
      created_at: Date;
    }>(
      `select r.id, r.title, r.status, r.amount_minor, r.created_at
         from ${table(context.run.schema, "records")} r
        ${clauses.length ? `where ${clauses.join(" and ")}` : ""}
        order by r.created_at desc limit 12`,
      params,
    );
    return ok(
      {
        records: rows.map((row) => ({
          id: row.id,
          title: row.title,
          status: row.status,
          amountMinor: Number(row.amount_minor),
          createdAt: row.created_at,
        })),
      },
      `${rows.length} matching record${rows.length === 1 ? "" : "s"}`,
    );
  },
});

export const requestBetterDocumentTool = defineTool({
  name: "request_better_document",
  description:
    "Ask for a clearer copy of a document and put the linked record on hold. Use when the read is too poor to trust.",
  kind: "write",
  agents: ["chat_orchestrator"],
  schema: z.object({
    record_id: z.string().uuid(),
    reason: z.string().min(1).max(400),
    idempotency_key: z.string().min(1).max(120).optional(),
  }),
  run: async (args, context) => {
    const session = requireWriter(context.session, "hold records");
    if ("ok" in session) return session;
    const record = await loadRecord(session.schema, args.record_id);
    if ("ok" in record) return record;
    if (!isOpen(record)) {
      return fail("not_permitted", `${record.title} is not waiting for review.`);
    }
    const { holdRecord } = await import("../../pipeline.server");
    const updated = await holdRecord(session, record.id, args.reason);
    return ok(
      {
        ...recordSummary(updated),
        request: `Please send a clearer copy of ${record.title}. ${args.reason}`,
      },
      `Asked for a clearer copy of ${record.title}`,
    );
  },
});

export const getUsageSummaryTool = defineTool({
  name: "get_usage_summary",
  description: "Give the workspace's voucher and bank-statement counts for the current period.",
  kind: "read",
  agents: ["chat_orchestrator"],
  schema: z.object({}),
  run: async (_args, context) => {
    const fyStart = context.run.settings.gst.fyStart;
    const rows = await sql<{ doc_type: string; n: number }>(
      `select doc_type, count(*)::int as n from ${table(context.run.schema, "records")}
        where status in ('posted','written') and posted_at >= $1::date
        group by doc_type`,
      [fyStart],
    );
    const counts = Object.fromEntries(rows.map((row) => [row.doc_type, Number(row.n)]));
    const vouchers = rows.reduce((sum, row) => sum + Number(row.n), 0);
    return ok(
      {
        periodStart: fyStart,
        vouchers,
        bankStatements: counts["bank_statement"] ?? 0,
        byDocType: counts,
      },
      `${vouchers} voucher${vouchers === 1 ? "" : "s"} this period`,
    );
  },
});

export const ORCHESTRATOR_TOOLS = [
  startProcessingTool,
  getBatchStatusTool,
  getDocumentStatusTool,
  getRecordCardTool,
  listNeedsAttentionTool,
  applyCorrectionTool,
  approveRecordsTool,
  rejectRecordsTool,
  holdRecordsTool,
  explainFlagTool,
  listDestinationsTool,
  connectDestinationTool,
  listSheetsTool,
  findRecordsTool,
  requestBetterDocumentTool,
  getUsageSummaryTool,
];
