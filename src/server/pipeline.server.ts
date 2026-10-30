import { createHash } from "node:crypto";

import { formatINR, STATUS_LABELS } from "@/lib/format";
import type {
  Destination,
  DocumentRow,
  FieldMap,
  RecordRow,
  ReviewEvidence,
  SessionUser,
} from "@/lib/types";
import { sql, sqlOne, table } from "./db.server";
import { enforceErrorBudget } from "./autonomy.server";
import type { ExtractionResult } from "./extraction";
import { connectorFor } from "./connectors.server";
import { gstinConfigured, verifyGstin } from "./gstin.server";
import { documentEvidence } from "./matching.server";
import { existingRecordKeys, getRecord, insertAssistantMessage, mapRecord } from "./repo.server";
import { evaluateDocument, overallConfidence, summarizeRules } from "./rules";
import { routeRecord, type RouteDecision } from "./router";
import { getSheetConnection } from "./settings.server";
import { confirmedSheetColumns } from "./posting.server";
import { loadCategoriserInput, runCategoriser } from "./agents/categoriser";
import { runExplainer } from "./agents/explainer";
import { runMatcher } from "./agents/matcher";
import {
  confirmedFieldDefaults,
  ensureVendorMaster,
  saveMatchDecision,
} from "./agents/store.server";
import type { AgentEnvelope, IngestAgentMeta, MatchResult, RuleExplanation } from "./agents/types";

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 40);

function businessKey(result: ExtractionResult): string {
  const f = result.fields;
  if (result.docType === "bank_statement") {
    return [f.invoice_date, f.reference_number, f.narration, f.debit, f.credit].join("|");
  }
  return [f.vendor_gstin, f.invoice_number, f.invoice_date, f.total].join("|");
}

async function logActivity(
  schema: string,
  userId: string,
  action: string,
  detail: Record<string, unknown>,
  recordId?: string,
) {
  await sql(
    `insert into ${table(schema, "activity")} (user_id, record_id, action, detail) values ($1, $2, $3, $4::jsonb)`,
    [userId, recordId ?? null, action, JSON.stringify(detail)],
  );
}

async function postedToday(schema: string): Promise<number> {
  const row = await sqlOne<{ n: number }>(
    `select count(*)::int as n from ${table(schema, "records")} where posted_at >= current_date`,
  );
  return Number(row?.n ?? 0);
}

interface DestinationRisk {
  /** False when the destination is unreachable or unauthorised. */
  healthy: boolean;
  /** False when a spreadsheet has no confirmed column mapping yet. */
  mappingConfirmed: boolean | undefined;
}

async function destinationRisk(
  session: SessionUser,
  destination: Destination,
): Promise<DestinationRisk> {
  let healthy = true;
  try {
    const health = await connectorFor(destination).health(session, session.tenantName);
    healthy = health.status === "connected" || health.status === "available";
  } catch {
    healthy = false;
  }
  if (destination !== "google_sheets") return { healthy, mappingConfirmed: undefined };
  const connection = await getSheetConnection(session);
  if (!connection) return { healthy, mappingConfirmed: false };
  const columns = await confirmedSheetColumns(session.schema, connection.id);
  return { healthy, mappingConfirmed: Boolean(columns) };
}

export interface DeliveryOptions {
  session: SessionUser;
  record: RecordRow;
  destination: Destination;
  source: "auto" | "manual";
}

/**
 * Writes one record to its destination and only reports success after the
 * connector returns. Retries reuse the same post row (destination + idempotency
 * key), so a double approve cannot create two vouchers or two sheet rows.
 */
export async function deliverRecord({
  session,
  record,
  destination,
  source,
}: DeliveryOptions): Promise<RecordRow> {
  const schema = session.schema;
  const existing = await sqlOne<{ id: string; status: string }>(
    `select id, status from ${table(schema, "posts")}
      where record_id = $1 and destination = $2 order by created_at desc limit 1`,
    [record.id, destination],
  );
  if (existing?.status === "posted") {
    return (await getRecord(schema, record.id)) ?? record;
  }
  if (existing?.status === "queued") {
    return (await getRecord(schema, record.id)) ?? record;
  }

  const postId =
    existing?.id ??
    (
      await sqlOne<{ id: string }>(
        `insert into ${table(schema, "posts")} (record_id, destination, idempotency_key, status)
         values ($1, $2, $3, 'pending')
         on conflict (destination, idempotency_key) do update set status = 'pending'
         returning id`,
        [record.id, destination, record.idempotencyKey],
      )
    )?.id;
  if (!postId) throw new Error("Could not open a posting job.");

  await sql(`update ${table(schema, "records")} set destination = $2 where id = $1`, [
    record.id,
    destination,
  ]);
  const prepared = { ...record, destination };
  const approvedLevel =
    source === "manual"
      ? session.permissionLevel
      : (record.permissionLevel ?? session.permissionLevel);

  try {
    const connector = connectorFor(destination);
    const outcome = await connector.write(
      session,
      prepared,
      session.tenantName,
      record.idempotencyKey,
    );
    if (!outcome.ok) throw new Error(outcome.message);
    const result = outcome.data;

    if (result.queued) {
      await sql(
        `update ${table(schema, "posts")}
            set status = 'queued', payload = $2::jsonb, result = $3::jsonb,
                bridge_command_id = $4::uuid, completed_at = null
          where id = $1`,
        [
          postId,
          JSON.stringify(result.payload),
          JSON.stringify({ ok: true, queued: true, note: result.note }),
          result.commandId ?? null,
        ],
      );
      await sql(
        `update ${table(schema, "records")}
            set status = 'approved', destination = $2, destination_note = $3,
                reviewed_at = case when $4 then now() else reviewed_at end,
                reviewed_by = case when $4 then $5::uuid else reviewed_by end,
                approved_permission_level = $6
          where id = $1`,
        [
          record.id,
          destination,
          result.note,
          source === "manual",
          source === "manual" ? session.userId : null,
          approvedLevel,
        ],
      );
      await logActivity(
        schema,
        session.userId,
        "record.queued",
        {
          destination,
          commandId: result.commandId ?? null,
          source,
          permissionLevel: approvedLevel,
        },
        record.id,
      );
      return (await getRecord(schema, record.id)) ?? prepared;
    }

    const finalStatus = destination === "tally" ? "posted" : "written";
    await sql(
      `update ${table(schema, "posts")}
          set status = 'posted', payload = $2::jsonb, result = $3::jsonb,
              external_ref = $4, completed_at = now()
        where id = $1`,
      [
        postId,
        JSON.stringify(result.payload),
        JSON.stringify({ ok: true, note: result.note }),
        result.externalRef,
      ],
    );
    await sql(
      `update ${table(schema, "records")}
          set status = $2, destination = $3, destination_ref = $4, destination_note = $5,
              posted_at = now(),
              reviewed_at = case when $6 then now() else reviewed_at end,
              reviewed_by = case when $6 then $7::uuid else reviewed_by end,
              approved_permission_level = $8
        where id = $1`,
      [
        record.id,
        finalStatus,
        destination,
        result.externalRef,
        result.note,
        source === "manual",
        source === "manual" ? session.userId : null,
        approvedLevel,
      ],
    );
    await logActivity(
      schema,
      session.userId,
      finalStatus === "posted" ? "record.posted" : "record.written",
      { destination, externalRef: result.externalRef, source, permissionLevel: approvedLevel },
      record.id,
    );
    return (await getRecord(schema, record.id)) ?? prepared;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The destination did not accept the record.";
    await sql(
      `update ${table(schema, "posts")} set status = 'failed', result = $2::jsonb, completed_at = now() where id = $1`,
      [postId, JSON.stringify({ ok: false, error: message })],
    );
    await sql(
      `update ${table(schema, "records")}
          set status = 'pending_review', destination = $2,
              destination_note = $3,
              reason = coalesce(nullif(reason, ''), '') ||
                case when coalesce(reason, '') = '' then '' else ' · ' end || $4
        where id = $1`,
      [record.id, destination, "The last write attempt failed.", message],
    );
    await logActivity(
      schema,
      session.userId,
      "record.post_failed",
      { destination, error: message },
      record.id,
    );
    throw new Error(message);
  }
}

export interface IngestOptions {
  session: SessionUser;
  chatId: string;
  document: DocumentRow;
  results: ExtractionResult[];
  destinationOverride?: Destination;
  messageId?: string | null;
  agent?: IngestAgentMeta;
}

export interface IngestOutcome {
  records: RecordRow[];
  summary: string;
}

function forceReview(decision: RouteDecision, reason: string): RouteDecision {
  return {
    action: "review",
    reasons: [...decision.reasons.filter((entry) => entry !== reason), reason],
    priority: Math.min(decision.priority, 30),
    shadow: false,
    wouldPost: false,
  };
}

export async function ingestExtraction({
  session,
  chatId,
  document,
  results,
  destinationOverride,
  messageId,
  agent,
}: IngestOptions): Promise<IngestOutcome> {
  const schema = session.schema;
  const existing = await existingRecordKeys(schema);
  await enforceErrorBudget(session);
  let posted = await postedToday(schema);
  const created: RecordRow[] = [];
  const learnedDefaults = new Map<string, Record<string, string>>();
  const riskCache = new Map<string, DestinationRisk>();

  const bankInput =
    agent && results.length && results.every((result) => result.docType === "bank_statement")
      ? await loadCategoriserInput(
          agent.context,
          results.map((result) => ({
            narration: String(result.fields.narration ?? ""),
            debit: Number(result.fields.debit ?? 0),
            credit: Number(result.fields.credit ?? 0),
            ...(result.fields.invoice_date ? { date: String(result.fields.invoice_date) } : {}),
          })),
        )
      : null;
  const bankOutput = bankInput && agent ? await runCategoriser(agent.context, bankInput) : null;

  for (const [index, result] of results.entries()) {
    const meta = agent?.results[index];
    const fields: FieldMap = {
      ...result.fields,
      ...(result.vendorStatus ? { vendor_status: result.vendorStatus } : {}),
    };
    const confidences = { ...result.confidences };
    if (result.vendorStatus) confidences.vendor_status = 0.98;

    const agentsUsed = new Set<string>(["document_classifier", "extraction"]);
    const warnings = [...(meta?.envelope.warnings ?? [])];

    let match: MatchResult | null = null;
    let matchRunId: string | null = null;
    if (
      agent &&
      result.docType !== "bank_statement" &&
      (fields.vendor_name || fields.vendor_gstin)
    ) {
      const matched = await runMatcher(agent.context, fields);
      match = matched.result;
      matchRunId = matched.runId ?? null;
      agentsUsed.add("master_matcher");
      warnings.push(...matched.envelope.warnings);
      if (match.vendor && match.status === "matched") {
        fields.vendor_name = match.vendor.name;
        confidences.vendor_name = Math.max(confidences.vendor_name ?? 0, match.confidence);
        fields.ledger = match.vendor.ledger ?? match.vendor.name;
        confidences.ledger = match.confidence;
      }
    }

    if (agent && fields.vendor_gstin) {
      const vendorKey = String(fields.vendor_gstin);
      let defaults = learnedDefaults.get(vendorKey);
      if (!defaults) {
        defaults = await confirmedFieldDefaults(schema, vendorKey);
        learnedDefaults.set(vendorKey, defaults);
      }
      for (const [field, value] of Object.entries(defaults)) {
        const current = fields[field];
        if (current === undefined || current === null || String(current).trim() === "") {
          fields[field] = value;
          confidences[field] = 0.7;
          warnings.push(
            `Used the confirmed ${field.replace(/_/g, " ")} learned for this supplier.`,
          );
        }
      }
    }

    let gstinEvidence: ReviewEvidence = {};
    if (result.docType !== "bank_statement" && fields.vendor_gstin && gstinConfigured()) {
      const lookup = await verifyGstin(String(fields.vendor_gstin));
      if (lookup.ok && lookup.data.verified) {
        fields.vendor_status = lookup.data.status ?? "unknown";
        confidences.vendor_status = 0.98;
        gstinEvidence = {
          gstinStatus: lookup.data.status ?? "unknown",
          gstinVerifiedAt: new Date().toISOString(),
          gstinName: lookup.data.tradeName ?? lookup.data.legalName ?? null,
        };
      } else if (!lookup.ok) {
        warnings.push("GSTN could not be reached, so the supplier's active status is unverified.");
      }
    }

    if (bankOutput && result.docType === "bank_statement") {
      const line = bankOutput.result.lines[index];
      if (line) {
        fields.ledger = line.ledger;
        fields.category = line.category;
        if (line.matchedVendor) fields.matched_vendor = line.matchedVendor;
        confidences.ledger = line.confidence;
        confidences.category = line.confidence;
        agentsUsed.add("bank_categoriser");
        if (index === 0) warnings.push(...bankOutput.envelope.warnings);
      }
    }

    const evidence =
      result.docType === "bank_statement" ? {} : await documentEvidence(schema, fields);
    const reviewEvidence: ReviewEvidence = {
      ...gstinEvidence,
      ...(evidence.threeWay
        ? {
            poMatched: evidence.threeWay.poMatched,
            grMatched: evidence.threeWay.grMatched,
            poReason: evidence.threeWay.poReason,
            grReason: evidence.threeWay.grReason,
            ...(evidence.threeWay.poNumber ? { poNumber: evidence.threeWay.poNumber } : {}),
          }
        : {}),
      ...(evidence.gstr2b
        ? {
            gstr2bMatch: evidence.gstr2b.status,
            gstr2bReason: evidence.gstr2b.reason,
            ...(evidence.gstr2b.period ? { gstr2bPeriod: evidence.gstr2b.period } : {}),
          }
        : {}),
    };
    const validation = evaluateDocument({
      docType: result.docType,
      fields,
      confidences,
      settings: session.settings,
      existing,
      ...(evidence.threeWay || evidence.gstr2b
        ? {
            match: {
              ...(evidence.threeWay ? { threeWay: evidence.threeWay } : {}),
              ...(evidence.gstr2b ? { gstr2b: evidence.gstr2b } : {}),
            },
          }
        : {}),
    });
    const confidence = overallConfidence(result.docType, fields, confidences);
    const amountMinor = Math.round(Number(fields.total ?? 0) * 100);
    const destination: Destination =
      destinationOverride ??
      (result.docType === "bank_statement" ? "google_sheets" : session.settings.defaultDestination);
    const idempotencyKey = hash(`${document.id}|${index}|${businessKey(result)}`);

    const duplicateRecord = await sqlOne<{ id: string }>(
      `select id from ${table(schema, "records")} where idempotency_key = $1`,
      [idempotencyKey],
    );
    if (duplicateRecord) continue;

    const riskKey = destination;
    const risk = riskCache.get(riskKey) ?? (await destinationRisk(session, destination));
    riskCache.set(riskKey, risk);

    let decision = routeRecord({
      destination,
      overallConfidence: confidence,
      rules: validation,
      amountMinor,
      settings: session.settings,
      autonomyMode: session.autonomyMode,
      autonomyStage: session.autonomyStage,
      shadowMode: session.shadowMode,
      killSwitch: session.killSwitch,
      postedToday: posted,
      docType: result.docType,
      vendorKnown: match?.status === "matched",
      learnedLedger: Boolean(match?.vendor?.ledger),
      permissionLevel: document.permissionLevel ?? session.permissionLevel,
      ceilingMinor: session.settings.permissions.ceilingMinor,
      mappingConfirmed: risk.mappingConfirmed,
      destinationHealthy: risk.healthy,
      documentQuality: meta?.suspectedQuality ? "suspect" : "good",
    });

    if (agent?.escalated) {
      decision = forceReview(decision, "An agent step failed, so this record needs a person.");
    }
    if (match?.status === "new_party") {
      decision = forceReview(decision, match.reason);
    } else if (match?.status === "ambiguous" && match.confidence < 0.75) {
      decision = forceReview(decision, "The supplier match is uncertain and needs confirmation.");
    }

    let explanation: RuleExplanation[] | null = null;
    if (agent) {
      const explained = await runExplainer(agent.context, {
        docType: result.docType,
        fields,
        rules: validation,
      });
      if (explained) {
        explanation = explained.result.explanations;
        agentsUsed.add("validation_explainer");
        warnings.push(...explained.envelope.warnings);
      }
    }

    const envelope: AgentEnvelope = {
      confidence,
      warnings: [...new Set(warnings)].slice(0, 12),
      reason:
        [meta?.envelope.reason, match?.reason, bankOutput?.envelope.reason]
          .filter((entry): entry is string => Boolean(entry))
          .join(" · ")
          .slice(0, 900) || "Deterministic ingestion.",
      ...(match
        ? {
            match: {
              status: match.status,
              confidence: match.confidence,
              reason: match.reason,
              vendorName: match.vendor?.name ?? null,
            },
          }
        : {}),
      ...(explanation?.length ? { explanations: explanation } : {}),
      ...(agent ? { agents: [...agentsUsed] } : {}),
      ...(agent?.escalated ? { escalated: true } : {}),
      ...(decision.shadow ? { shadow: true, wouldPost: true } : {}),
      ...(Object.keys(reviewEvidence).length ? { evidence: reviewEvidence } : {}),
    };

    let assignedTo: string | null = null;
    let dueAt: string | null = null;
    if (decision.action === "review") {
      if (session.settings.review.autoAssign) {
        const candidate = await sqlOne<{ id: string }>(
          `select u.id
             from bahi.memberships m join bahi.users u on u.id = m.user_id
            where m.tenant_id = $1 and m.role in ('owner', 'reviewer')
            order by (
              select count(*) from ${table(schema, "records")} r
               where r.assigned_to = u.id and r.status in ('pending_review', 'held')
            ) asc, random()
            limit 1`,
          [session.tenantId],
        );
        assignedTo = candidate?.id ?? session.userId;
      }
      if (session.settings.review.dueDays) {
        dueAt = new Date(Date.now() + session.settings.review.dueDays * 86_400_000).toISOString();
      }
    }

    const inserted = await sqlOne<Record<string, unknown>>(
      `insert into ${table(schema, "records")}
        (chat_id, message_id, document_id, doc_type, title, fields, confidences, validation,
         overall_confidence, status, destination, reason, priority, amount_minor, idempotency_key,
         group_key, envelope, agent_mode, assigned_to, due_at, review_reason, locations, shadow,
         source_channel, evidence, permission_level)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, 'pending_review', $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19, $20, $21::jsonb, $22, $23, $24::jsonb, $25)
       returning *`,
      [
        chatId,
        messageId ?? null,
        document.id,
        result.docType,
        result.title,
        JSON.stringify(fields),
        JSON.stringify(confidences),
        JSON.stringify(validation),
        confidence,
        destination,
        decision.action === "review" ? decision.reasons.join(" · ") : null,
        decision.priority,
        amountMinor,
        idempotencyKey,
        document.id,
        JSON.stringify(envelope),
        agent?.mode ?? null,
        assignedTo,
        dueAt,
        decision.action === "review" ? (decision.reasons[0] ?? null) : null,
        JSON.stringify(result.locations ?? {}),
        decision.shadow,
        document.sourceChannel ?? "chat",
        JSON.stringify(reviewEvidence),
        document.permissionLevel ?? session.permissionLevel,
      ],
    );
    if (!inserted) continue;

    existing.push({
      id: String(inserted.id),
      vendorGstin: fields.vendor_gstin ?? null,
      invoiceNumber: fields.invoice_number ?? null,
      amountMinor,
      title: result.title,
    });

    let record = mapRecord(inserted);

    if (agent && match) {
      await saveMatchDecision(
        { ...agent.context, recordId: record.id },
        {
          recordId: record.id,
          kind: "vendor",
          input: {
            vendorName: result.fields.vendor_name ?? null,
            vendorGstin: result.fields.vendor_gstin ?? null,
          },
          match,
          agentRunId: matchRunId,
        },
      );
    }

    await logActivity(
      schema,
      session.userId,
      "record.created",
      {
        docType: result.docType,
        confidence,
        status: decision.action,
        mode: agent?.mode ?? "deterministic",
        permissionLevel: document.permissionLevel ?? session.permissionLevel,
      },
      record.id,
    );

    if (decision.action === "auto_post") {
      try {
        record = await deliverRecord({ session, record, destination, source: "auto" });
        if (record.status === "posted" || record.status === "written") posted += 1;
      } catch {
        record = (await getRecord(schema, record.id)) ?? record;
      }
    }

    created.push(record);
  }

  await sql(
    `update ${table(schema, "documents")} set status = 'extracted', doc_type = $2 where id = $1`,
    [document.id, results[0]?.docType ?? null],
  );

  return { records: created, summary: summarizeRecords(created) };
}

export function summarizeRecords(records: RecordRow[]): string {
  if (!records.length) {
    return "I could not find any invoice or statement lines in that document. Try another file, or paste the details as text.";
  }

  const lines = records.map((record) => {
    const amount = formatINR(record.amountMinor);
    if (record.status === "posted" || record.status === "written") {
      const place =
        record.destination === "tally"
          ? "Tally"
          : record.destination === "excel"
            ? "Excel"
            : "Google Sheets";
      const ref = record.destinationRef ? ` as ${record.destinationRef}` : "";
      return `${record.title} — ${amount} · written to ${place}${ref}.`;
    }
    const failed = summarizeRules(record.validation).failed;
    const reasons = failed.length
      ? failed
          .map((rule) => rule.message)
          .slice(0, 2)
          .join(" ")
      : (record.reason ?? "It is waiting for your review.");
    return `${record.title} — ${amount} · needs review. ${reasons}`;
  });

  const written = records.filter((r) => r.status === "posted" || r.status === "written").length;
  const pending = records.length - written;
  const opening =
    records.length === 1
      ? "I read one record and checked it against the manufacturing pack."
      : `I read ${records.length} records and checked each one against the manufacturing pack.`;

  const closing =
    pending > 0
      ? `${pending} ${pending === 1 ? "record is" : "records are"} ready in the chat card and the review queue. Fix anything that looks wrong, then approve.`
      : "Nothing needs your attention. Everything cleared validation and was written.";

  return `${opening}\n\n${lines.map((line) => `• ${line}`).join("\n")}\n\n${closing}`;
}

export interface ApproveOptions {
  fields?: FieldMap;
  destination?: Destination;
  note?: string;
}

export async function approveRecord(
  session: SessionUser,
  recordId: string,
  options: ApproveOptions = {},
): Promise<RecordRow> {
  const schema = session.schema;
  const record = await getRecord(schema, recordId);
  if (!record) throw new Error("Record not found.");
  if (record.status === "posted" || record.status === "written") return record;

  const mergedFields: FieldMap = { ...record.fields, ...(options.fields ?? {}) };
  const confidences = { ...record.confidences };
  const corrections: { field: string; oldValue: string; newValue: string }[] = [];

  for (const [key, value] of Object.entries(options.fields ?? {})) {
    if (String(record.fields[key] ?? "") !== String(value ?? "")) {
      confidences[key] = 1;
      corrections.push({
        field: key,
        oldValue: String(record.fields[key] ?? ""),
        newValue: String(value ?? ""),
      });
    }
  }

  const keys = (await existingRecordKeys(schema)).filter((key) => key.id !== record.id);
  const validation = evaluateDocument({
    docType: record.docType,
    fields: mergedFields,
    confidences,
    settings: session.settings,
    existing: keys,
  });
  const confidence = overallConfidence(record.docType, mergedFields, confidences);
  const failed = summarizeRules(validation).failed;
  const destination = options.destination ?? record.destination;

  const reason =
    failed.length > 0
      ? `Approved by ${session.name} with ${failed.length} override${failed.length === 1 ? "" : "s"}: ${failed
          .map((rule) => rule.label)
          .join(", ")}.`
      : (options.note ?? null);

  await sql(
    `update ${table(schema, "records")}
        set fields = $2::jsonb, confidences = $3::jsonb, validation = $4::jsonb,
            overall_confidence = $5, destination = $6, reason = $7,
            shadow = false, due_at = null, review_reason = null
      where id = $1`,
    [
      record.id,
      JSON.stringify(mergedFields),
      JSON.stringify(confidences),
      JSON.stringify(validation),
      confidence,
      destination,
      reason,
    ],
  );

  for (const correction of corrections) {
    await sql(
      `insert into ${table(schema, "corrections")}
        (record_id, document_id, doc_type, vendor_key, field, old_value, new_value, user_id, reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        record.id,
        record.documentId,
        record.docType,
        mergedFields.vendor_gstin ?? null,
        correction.field,
        correction.oldValue,
        correction.newValue,
        session.userId,
        options.note?.trim() || null,
      ],
    );
  }

  if (record.docType !== "bank_statement" && mergedFields.vendor_name) {
    await ensureVendorMaster(schema, {
      name: String(mergedFields.vendor_name),
      gstin: mergedFields.vendor_gstin ? String(mergedFields.vendor_gstin) : null,
      ledger: mergedFields.ledger ? String(mergedFields.ledger) : String(mergedFields.vendor_name),
    });
  }

  if (corrections.length) {
    await logActivity(
      schema,
      session.userId,
      "record.corrected",
      { fields: corrections.map((correction) => correction.field) },
      record.id,
    );
  }

  const updated = (await getRecord(schema, record.id))!;
  const delivered = await deliverRecord({
    session,
    record: updated,
    destination,
    source: "manual",
  });
  if (record.chatId) {
    await sql(`update ${table(schema, "chats")} set updated_at = now() where id = $1`, [
      record.chatId,
    ]);
  }
  return delivered;
}

export async function rejectRecord(
  session: SessionUser,
  recordId: string,
  reason: string,
): Promise<RecordRow> {
  const schema = session.schema;
  if (!reason.trim()) throw new Error("A reason is required to reject a record.");
  const record = await getRecord(schema, recordId);
  if (!record) throw new Error("Record not found.");
  await sql(
    `update ${table(schema, "records")}
        set status = 'rejected', reason = $2, reviewed_at = now(), reviewed_by = $3
      where id = $1`,
    [recordId, reason.trim(), session.userId],
  );
  await logActivity(schema, session.userId, "record.rejected", { reason: reason.trim() }, recordId);
  return (await getRecord(schema, recordId))!;
}

export async function holdRecord(
  session: SessionUser,
  recordId: string,
  note: string,
): Promise<RecordRow> {
  const schema = session.schema;
  await sql(`update ${table(schema, "records")} set status = 'held', reason = $2 where id = $1`, [
    recordId,
    note.trim() || "On hold.",
  ]);
  await logActivity(schema, session.userId, "record.held", { note }, recordId);
  return (await getRecord(schema, recordId))!;
}

export async function saveRecordFields(
  session: SessionUser,
  recordId: string,
  fields: FieldMap,
  options: { reason?: string; oneOff?: boolean } = {},
): Promise<RecordRow> {
  const schema = session.schema;
  const record = await getRecord(schema, recordId);
  if (!record) throw new Error("Record not found.");
  const merged = { ...record.fields, ...fields };
  const confidences = { ...record.confidences };
  for (const key of Object.keys(fields)) confidences[key] = 1;
  const corrections = Object.entries(fields)
    .map(([field, value]) => ({
      field,
      oldValue: String(record.fields[field] ?? ""),
      newValue: String(value ?? ""),
    }))
    .filter((correction) => correction.oldValue !== correction.newValue);
  const keys = (await existingRecordKeys(schema)).filter((key) => key.id !== record.id);
  const validation = evaluateDocument({
    docType: record.docType,
    fields: merged,
    confidences,
    settings: session.settings,
    existing: keys,
  });
  const confidence = overallConfidence(record.docType, merged, confidences);
  await sql(
    `update ${table(schema, "records")}
        set fields = $2::jsonb, confidences = $3::jsonb, validation = $4::jsonb, overall_confidence = $5
      where id = $1`,
    [
      recordId,
      JSON.stringify(merged),
      JSON.stringify(confidences),
      JSON.stringify(validation),
      confidence,
    ],
  );
  for (const correction of corrections) {
    await sql(
      `insert into ${table(schema, "corrections")}
        (record_id, document_id, doc_type, vendor_key, field, old_value, new_value, user_id, reason, one_off)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        record.id,
        record.documentId,
        record.docType,
        merged.vendor_gstin ?? null,
        correction.field,
        correction.oldValue,
        correction.newValue,
        session.userId,
        options.reason?.trim() || "Edited before approval.",
        options.oneOff ?? false,
      ],
    );
  }
  if (corrections.length) {
    await logActivity(
      schema,
      session.userId,
      "record.corrected",
      { fields: corrections.map((correction) => correction.field), source: "edit" },
      record.id,
    );
  }
  return (await getRecord(schema, recordId))!;
}

export interface ToolChip {
  name: string;
  status: "ok" | "failed";
  summary: string;
}

export async function insertSummaryMessage(
  schema: string,
  chatId: string,
  content: string,
  recordIds: string[],
  tool?: ToolChip,
) {
  return insertAssistantMessage(schema, chatId, content, {
    kind: "upload_result",
    recordIds,
    ...(tool ? { tools: [tool] } : {}),
  });
}

export { STATUS_LABELS };
