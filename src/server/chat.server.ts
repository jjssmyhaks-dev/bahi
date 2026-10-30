import { DESTINATION_LABELS, formatINR } from "@/lib/format";
import type {
  ChatMessage,
  Destination,
  FieldMap,
  FieldValue,
  RecordRow,
  SessionUser,
} from "@/lib/types";
import {
  createSampleDocument,
  createTypedDocument,
  storeDocument,
  type IncomingFile,
} from "./documents.server";
import { getSampleDocument, parseDate } from "./extraction";
import { looksLikeInvoiceText, parseChatAction, type ChatAction, type PendingRef } from "./intents";
import {
  approveRecord,
  holdRecord,
  insertSummaryMessage,
  rejectRecord,
  saveRecordFields,
} from "./pipeline.server";
import { agentsEnabled } from "./agents/config";
import { runOrchestrator } from "./agents/orchestrator";
import { agentToolChip, processDocumentText } from "./agents/pipeline.server";
import { contextFromSession, type OrchestratorIntent } from "./agents/types";
import {
  createChat,
  getChat,
  insertAssistantMessage,
  insertUserMessage,
  listChats,
  listDocumentsForChat,
  listQueue,
  listRecordsForChat,
  touchChat,
} from "./repo.server";
import { summarizeRules } from "./rules";

export interface ChatPayload {
  chatId: string;
  title: string;
  messages: ChatMessage[];
  records: RecordRow[];
}

type ToolChip = { name: string; status: "ok" | "failed"; summary: string };

const HELP_TEXT = `I can do three things in this conversation.

• **Read** — upload a PDF, CSV or Excel file, or paste the invoice or statement details.
• **Check** — I verify the GSTIN, place of supply, tax arithmetic, totals, duplicates and dates against the manufacturing pack.
• **Enter** — records that pass go straight into TallyPrime, Excel or Google Sheets. Anything uncertain becomes a card here and in the review queue.

When something is waiting, you can just tell me: “approve the first one”, “post the Apex invoice to Google Sheets”, “change the total to 1,35,936”, “hold the last one” or “reject it because the GSTIN is cancelled”.`;

const FIELD_LABELS: Record<string, string> = {
  vendor_name: "vendor name",
  vendor_gstin: "GSTIN",
  invoice_number: "document number",
  invoice_date: "date",
  place_of_supply: "place of supply",
  total: "total",
  taxable_value: "taxable value",
};

const MONEY_FIELDS = new Set([
  "total",
  "taxable_value",
  "cgst",
  "sgst",
  "igst",
  "round_off",
  "debit",
  "credit",
  "balance",
]);

function isOpen(record: RecordRow): boolean {
  return record.status === "pending_review" || record.status === "held";
}

function toPendingRef(record: RecordRow): PendingRef {
  const fields = record.fields;
  return {
    id: record.id,
    title: record.title,
    ...(fields.vendor_name ? { vendorName: String(fields.vendor_name) } : {}),
    ...(fields.invoice_number ? { invoiceNumber: String(fields.invoice_number) } : {}),
    amountMinor: record.amountMinor,
  };
}

function pickTargets(targets: number[] | "all", pending: RecordRow[]): RecordRow[] {
  if (targets === "all") return pending;
  return targets
    .map((index) => pending[index])
    .filter((record): record is RecordRow => record !== undefined);
}

function destinationFromText(text: string): Destination | undefined {
  if (/\btally(?:prime)?\b/i.test(text)) return "tally";
  if (/\bexcel\b|xlsx|workbook/i.test(text)) return "excel";
  if (/\bgoogle\s*sheets?\b|\bsheets?\b/i.test(text)) return "google_sheets";
  return undefined;
}

function assertWriter(session: SessionUser) {
  if (session.role === "viewer")
    throw new Error("Viewers can read the workspace but cannot change records.");
}

async function payload(session: SessionUser, chatId: string): Promise<ChatPayload> {
  const data = await getChat(session.schema, chatId, session.userId);
  if (!data) throw new Error("Conversation not found.");
  return { chatId, title: data.chat.title, messages: data.messages, records: data.records };
}

export async function getChatPayload(session: SessionUser, chatId: string): Promise<ChatPayload> {
  return payload(session, chatId);
}

async function resolveChat(
  session: SessionUser,
  chatId?: string,
): Promise<{ chatId: string; isNew: boolean; title: string }> {
  if (chatId) {
    const existing = await getChat(session.schema, chatId, session.userId);
    if (!existing) throw new Error("Conversation not found.");
    return { chatId, isNew: false, title: existing.chat.title };
  }
  const chats = await listChats(session.schema, session.userId);
  if (chats[0]) return { chatId: chats[0].id, isNew: false, title: chats[0].title };
  return {
    chatId: await createChat(session.schema, session.userId),
    isNew: true,
    title: "New conversation",
  };
}

async function say(
  session: SessionUser,
  chatId: string,
  content: string,
  meta: Record<string, unknown> = { kind: "intent_result" },
  tool?: ToolChip | ToolChip[],
) {
  const tools = tool ? (Array.isArray(tool) ? tool : [tool]) : null;
  await insertAssistantMessage(session.schema, chatId, content, tools ? { ...meta, tools } : meta);
}

function titleFor(text: string, fallback = "New conversation"): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return fallback;
  return flat.length > 52 ? `${flat.slice(0, 49)}…` : flat;
}

async function renameIfNew(
  session: SessionUser,
  chatId: string,
  isNew: boolean,
  currentTitle: string,
  title: string,
) {
  if (isNew || currentTitle === "New conversation") {
    await touchChat(session.schema, chatId, titleFor(title));
  }
}

function openQueueSummary(records: RecordRow[]): string {
  if (!records.length) {
    return "Nothing is waiting right now. Upload a document whenever you're ready — or try one of the samples.";
  }
  const lines = records.slice(0, 5).map((record) => {
    const failed = summarizeRules(record.validation).failed.length;
    const why = failed
      ? `${failed} rule${failed === 1 ? "" : "s"} failed`
      : `${Math.round(record.overallConfidence * 100)}% confidence`;
    return `• ${record.title} — ${formatINR(record.amountMinor)} · ${why}`;
  });
  return `${records.length} record${records.length === 1 ? "" : "s"} waiting for a person:\n\n${lines.join("\n")}\n\nOpen the review queue, or tell me what to do with any of them.`;
}

async function ingestTypedText(session: SessionUser, chatId: string, text: string): Promise<void> {
  const typed = await createTypedDocument(session, chatId, text);
  const destination = destinationFromText(text);
  const outcome = await processDocumentText({
    session,
    chatId,
    document: typed.document,
    text,
    filename: typed.document.filename,
    ...(destination ? { destinationOverride: destination } : {}),
  });
  await insertSummaryMessage(
    session.schema,
    chatId,
    outcome.summary,
    outcome.records.map((record) => record.id),
    agentToolChip(outcome),
  );
}

function coerceField(field: string, value: string): FieldValue {
  if (MONEY_FIELDS.has(field)) {
    const number = Number(value.replace(/[₹,\s]/g, ""));
    return Number.isFinite(number) ? number : value;
  }
  if (field === "invoice_date") return parseDate(value) ?? value;
  if (field === "vendor_gstin") return value.replace(/\s+/g, "").toUpperCase();
  return value;
}

function displayValue(field: string, value: unknown): string {
  if (MONEY_FIELDS.has(field) && typeof value === "number")
    return formatINR(Math.round(value * 100), 2);
  return String(value);
}

async function runAction(
  session: SessionUser,
  chatId: string,
  action: ChatAction,
  pending: RecordRow[],
  tool?: ToolChip,
): Promise<void> {
  if (action.type === "question") {
    await say(session, chatId, action.question, { kind: "intent_result" }, tool);
    return;
  }

  if (action.type === "approve") {
    const targets = pickTargets(action.targets, pending);
    const lines: string[] = [];
    for (const record of targets) {
      try {
        const updated = await approveRecord(session, record.id, {
          ...(action.destination ? { destination: action.destination } : {}),
        });
        if (updated.status === "posted" || updated.status === "written") {
          const place = DESTINATION_LABELS[updated.destination];
          const overrides = updated.reason?.startsWith("Approved by")
            ? " (your override is on the record)"
            : "";
          lines.push(
            `• ${record.title} — written to ${place}${updated.destinationRef ? ` as ${updated.destinationRef}` : ""}${overrides}.`,
          );
        } else {
          lines.push(`• ${record.title} — still needs a look. ${updated.reason ?? ""}`);
        }
      } catch (error) {
        lines.push(
          `• ${record.title} — could not write it. ${error instanceof Error ? error.message : "The destination refused it."}`,
        );
      }
    }
    await say(
      session,
      chatId,
      lines.length === 1
        ? `Done. Here's where it landed.\n\n${lines.join("\n")}`
        : `Done. Here's what happened to each one.\n\n${lines.join("\n")}`,
      { kind: "intent_result", recordIds: targets.map((record) => record.id) },
      tool,
    );
    return;
  }

  if (action.type === "reject") {
    const targets = pickTargets(action.targets, pending);
    for (const record of targets) await rejectRecord(session, record.id, action.reason);
    await say(
      session,
      chatId,
      `${targets.length === 1 ? "Rejected" : `Rejected ${targets.length} records`}. Nothing was written. Reason kept on the record: “${action.reason}”.`,
      { kind: "intent_result", recordIds: targets.map((record) => record.id) },
      tool,
    );
    return;
  }

  if (action.type === "hold") {
    const targets = pickTargets(action.targets, pending);
    for (const record of targets) await holdRecord(session, record.id, action.note);
    await say(
      session,
      chatId,
      `${targets.length === 1 ? "Held" : `Held ${targets.length} records`} for later. Say “approve” when you want them written.`,
      { kind: "intent_result", recordIds: targets.map((record) => record.id) },
      tool,
    );
    return;
  }

  if (action.type === "correct") {
    const record =
      action.target === null
        ? pending.length === 1
          ? pending[0]
          : undefined
        : pending[action.target];
    if (!record) {
      await say(
        session,
        chatId,
        "Which record should I update? Tell me the number or the supplier name.",
        { kind: "intent_result" },
        tool,
      );
      return;
    }
    const value = coerceField(action.field, action.value);
    const updated = await saveRecordFields(session, record.id, { [action.field]: value });
    const failed = summarizeRules(updated.validation).failed;
    const label = FIELD_LABELS[action.field] ?? action.field.replace(/_/g, " ");
    const closing = failed.length
      ? `It still needs a look: ${failed.map((rule) => rule.message).join(" ")}`
      : "Every check passes now — say “approve it” when you're ready.";
    await say(
      session,
      chatId,
      `Updated the ${label} on “${record.title}” to ${displayValue(action.field, value)}.\n\n${closing}`,
      { kind: "intent_result", recordIds: [record.id] },
      tool,
    );
  }
}

export interface SendMessageInput {
  chatId?: string;
  text: string;
}

function actionFromIntent(intent: OrchestratorIntent, pending: RecordRow[]): ChatAction | null {
  const targets = intent.targets
    .map((target) => target - 1)
    .filter((target) => target >= 0 && target < pending.length);
  if (!targets.length) return null;

  if (intent.intent === "approve") {
    return {
      type: "approve",
      targets,
      ...(intent.destination ? { destination: intent.destination } : {}),
    };
  }
  if (intent.intent === "reject") {
    return { type: "reject", targets, reason: intent.reason ?? "Rejected in the chat." };
  }
  if (intent.intent === "hold") {
    return { type: "hold", targets, note: intent.reason ?? "Held from the chat." };
  }
  if (intent.intent === "correct" && intent.field && intent.value) {
    return {
      type: "correct",
      field: intent.field,
      value: intent.value,
      target: targets[0] ?? null,
    };
  }
  return null;
}

export async function sendMessage(
  session: SessionUser,
  input: SendMessageInput,
): Promise<ChatPayload> {
  assertWriter(session);
  const text = input.text.trim();
  if (!text) throw new Error("Write a message first.");

  const { chatId, isNew, title } = await resolveChat(session, input.chatId);
  const before = await listRecordsForChat(session.schema, chatId);
  const pending = before.filter(isOpen);

  await insertUserMessage(session.schema, chatId, text, { kind: "text" });
  await renameIfNew(session, chatId, isNew, title, text);
  if (!isNew) await touchChat(session.schema, chatId);

  const commandLike =
    /^(change|set|update|approve|accept|confirm|post|write|send|reject|discard|delete|remove|hold|park|wait|don'?t|do not)\b/i.test(
      text,
    );

  if (pending.length && commandLike) {
    const action = parseChatAction(text, pending.map(toPendingRef));
    if (action.type !== "none") {
      await runAction(session, chatId, action, pending);
      return payload(session, chatId);
    }
  }

  if (looksLikeInvoiceText(text)) {
    await ingestTypedText(session, chatId, text);
    return payload(session, chatId);
  }

  if (pending.length) {
    const action = parseChatAction(text, pending.map(toPendingRef));
    if (action.type !== "none") {
      await runAction(session, chatId, action, pending);
      return payload(session, chatId);
    }
  }

  if (agentsEnabled()) {
    const context = contextFromSession(session, { chatId });
    const documents = await listDocumentsForChat(session.schema, chatId);
    const orchestrator = await runOrchestrator(context, {
      message: text,
      pending: pending.map((record) => ({
        id: record.id,
        title: record.title,
        status: record.status,
        amountMinor: record.amountMinor,
        ...(record.fields.vendor_name ? { vendorName: String(record.fields.vendor_name) } : {}),
        ...(record.fields.invoice_number
          ? { invoiceNumber: String(record.fields.invoice_number) }
          : {}),
      })),
      documents,
    });
    const intent = orchestrator.result;
    const calls = orchestrator.toolCalls ?? [];
    const chips: ToolChip[] = calls.map((call) => ({
      name: call.name,
      status: call.status === "ok" ? "ok" : "failed",
      summary: call.summary,
    }));
    const tool: ToolChip = calls.length
      ? {
          name: "Tools",
          status: chips.some((chip) => chip.status === "failed") ? "failed" : "ok",
          summary: chips.map((chip) => chip.name).join(" · "),
        }
      : {
          name: "Chat orchestrator",
          status: orchestrator.envelope.confidence > 0 ? "ok" : "failed",
          summary: `Intent: ${intent.intent}`,
        };

    if (calls.length) {
      const reply =
        intent.reply?.trim() ||
        calls
          .map((call) => call.summary)
          .filter(Boolean)
          .join(" ") ||
        "Done.";
      await say(session, chatId, reply, { kind: "intent_result" }, chips);
      return payload(session, chatId);
    }

    if (intent.reply) {
      await say(session, chatId, intent.reply, { kind: "intent_result" }, tool);
      return payload(session, chatId);
    }

    const action = actionFromIntent(intent, pending);
    if (action) {
      await runAction(session, chatId, action, pending, tool);
      return payload(session, chatId);
    }

    if (intent.intent === "status") {
      const queue = await listQueue(session.schema);
      await say(session, chatId, openQueueSummary(queue), { kind: "intent_result" }, tool);
      return payload(session, chatId);
    }

    if (intent.intent === "help") {
      await say(session, chatId, HELP_TEXT, { kind: "text" }, tool);
      return payload(session, chatId);
    }
  }

  if (/(pending|waiting|review|queue|needs? attention|status)/i.test(text)) {
    const queue = await listQueue(session.schema);
    await say(session, chatId, openQueueSummary(queue));
    return payload(session, chatId);
  }

  if (
    /^(hi|hello|hey|namaste|good (morning|evening|afternoon))\b/i.test(text) ||
    /help|what can you do/i.test(text)
  ) {
    await say(session, chatId, HELP_TEXT, { kind: "text" });
    return payload(session, chatId);
  }

  await say(
    session,
    chatId,
    "I didn't find a document in that message. Attach a PDF, Excel file, CSV or a photo of the bill — or paste the supplier, GSTIN, invoice number and total. I can also tell you what's waiting for review.",
  );
  return payload(session, chatId);
}

export interface IngestFilesInput {
  chatId?: string;
  files: IncomingFile[];
  note?: string;
  destination?: Destination;
  sourceChannel?: RecordRow["sourceChannel"];
}

export type IngestResult = ChatPayload & { documentIds: string[] };

export async function ingestFiles(
  session: SessionUser,
  input: IngestFilesInput,
): Promise<IngestResult> {
  assertWriter(session);
  if (!input.files.length) throw new Error("Choose a file to upload.");

  const { chatId, isNew, title } = await resolveChat(session, input.chatId);
  const names = input.files.map((file) => file.name);
  const caption =
    input.note?.trim() ||
    (names.length === 1 ? `Uploaded ${names[0]}.` : `Uploaded ${names.length} files.`);

  await insertUserMessage(session.schema, chatId, caption, {
    kind: "text",
    attachments: input.files.map((file) => ({
      name: file.name,
      size: Math.round((file.base64.length * 3) / 4),
      mime: file.mimeType,
    })),
  });
  await renameIfNew(session, chatId, isNew, title, caption);
  if (!isNew) await touchChat(session.schema, chatId);

  const destination = input.destination ?? destinationFromText(`${caption} ${input.note ?? ""}`);
  const documentIds: string[] = [];

  for (const file of input.files) {
    const stored = await storeDocument(session, chatId, file, input.sourceChannel ?? "chat");
    if (stored.duplicateOf) {
      await say(session, chatId, stored.error ?? "That file has already been uploaded.");
      continue;
    }
    if (stored.error) {
      await say(session, chatId, `I couldn't read **${file.name}**.\n\n${stored.error}`, {
        kind: "upload_result",
        documents: 1,
      });
      continue;
    }
    documentIds.push(stored.document.id);

    const outcome = await processDocumentText({
      session,
      chatId,
      document: stored.document,
      text: stored.text,
      filename: file.name,
      ...(destination ? { destinationOverride: destination } : {}),
    });
    if (!outcome.records.length) {
      await say(
        session,
        chatId,
        outcome.summary,
        { kind: "upload_result", documents: 1 },
        agentToolChip(outcome),
      );
      continue;
    }
    await insertSummaryMessage(
      session.schema,
      chatId,
      outcome.summary,
      outcome.records.map((record) => record.id),
      agentToolChip(outcome),
    );
  }

  return { ...(await payload(session, chatId)), documentIds };
}

export interface StartSampleInput {
  chatId?: string;
  sampleId: string;
}

export async function startSample(
  session: SessionUser,
  input: StartSampleInput,
): Promise<ChatPayload> {
  assertWriter(session);
  const sample = getSampleDocument(input.sampleId);
  if (!sample) throw new Error("That sample is not available.");

  const { chatId, isNew, title } = await resolveChat(session, input.chatId);
  await insertUserMessage(session.schema, chatId, `Try the “${sample.label}” sample.`, {
    kind: "text",
    attachments: [
      {
        name: sample.filename,
        size: Buffer.byteLength(sample.text, "utf8"),
        mime: sample.mimeType,
      },
    ],
  });
  await renameIfNew(session, chatId, isNew, title, sample.label);
  if (!isNew) await touchChat(session.schema, chatId);

  const document = await createSampleDocument(session, chatId, sample);
  const outcome = await processDocumentText({
    session,
    chatId,
    document,
    text: sample.text,
    filename: sample.filename,
    ...(sample.confidenceOverrides ? { overrides: sample.confidenceOverrides } : {}),
    ...(sample.vendorStatus ? { vendorStatus: sample.vendorStatus } : {}),
  });
  await insertSummaryMessage(
    session.schema,
    chatId,
    outcome.summary,
    outcome.records.map((record) => record.id),
    agentToolChip(outcome),
  );
  return payload(session, chatId);
}

export interface RecordActionInput {
  recordId: string;
  action: "approve" | "reject" | "hold";
  destination?: Destination;
  reason?: string;
  note?: string;
}

export async function actOnRecord(
  session: SessionUser,
  input: RecordActionInput,
): Promise<RecordRow> {
  assertWriter(session);
  let record: RecordRow;
  let content: string;

  if (input.action === "approve") {
    record = await approveRecord(session, input.recordId, {
      ...(input.destination ? { destination: input.destination } : {}),
    });
    content =
      record.status === "posted" || record.status === "written"
        ? `“${record.title}” is now in ${DESTINATION_LABELS[record.destination]}${
            record.destinationRef ? ` as ${record.destinationRef}` : ""
          }.`
        : `“${record.title}” is still waiting. ${record.reason ?? ""}`;
  } else if (input.action === "reject") {
    record = await rejectRecord(
      session,
      input.recordId,
      input.reason ?? "Rejected from the review queue.",
    );
    content = `“${record.title}” was rejected. Nothing was written.`;
  } else {
    record = await holdRecord(session, input.recordId, input.note ?? "Held from the review queue.");
    content = `“${record.title}” is on hold.`;
  }

  if (record.chatId) {
    await say(session, record.chatId, content, { kind: "intent_result", recordIds: [record.id] });
  }
  return record;
}

export async function saveFields(
  session: SessionUser,
  recordId: string,
  fields: FieldMap,
): Promise<RecordRow> {
  assertWriter(session);
  return saveRecordFields(session, recordId, fields);
}

export async function newChat(session: SessionUser): Promise<string> {
  assertWriter(session);
  return createChat(session.schema, session.userId);
}
