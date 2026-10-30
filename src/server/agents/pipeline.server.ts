import type { Destination, DocType, DocumentRow, FieldMap, SessionUser } from "@/lib/types";
import { sql, table } from "../db.server";
import type { ExtractionResult } from "../extraction";
import { ingestExtraction, type IngestOutcome } from "../pipeline.server";
import { runClassifier } from "./classifier";
import { agentsEnabled } from "./config";
import { extractorSchema, runExtractor, toExtractionResults } from "./extractor";
import {
  findCachedExtraction,
  markSegmentsExtracted,
  saveExtraction,
  saveSegments,
} from "./store.server";
import {
  contextFromSession,
  type AgentMode,
  type ClassifiedSegment,
  type IngestAgentMeta,
} from "./types";

export interface ProcessDocumentInput {
  session: SessionUser;
  chatId: string;
  document: DocumentRow;
  text: string;
  filename: string;
  overrides?: Record<string, number>;
  vendorStatus?: FieldMap["vendor_status"];
  destinationOverride?: Destination;
}

export interface ProcessDocumentOutcome extends IngestOutcome {
  segments: number;
  unknownSegments: number;
  mode: AgentMode;
  escalated: boolean;
}

async function markUnreadable(schema: string, documentId: string, reason: string): Promise<void> {
  await sql(
    `update ${table(schema, "documents")}
        set status = 'needs_attention', error = $2, doc_type = null
      where id = $1`,
    [documentId, reason],
  );
}

function segmentQualityIsSuspect(segment: ClassifiedSegment): boolean {
  const { blurred, cropped, rotated, note } = segment.quality;
  return (
    Boolean(blurred || cropped || rotated || note) ||
    segment.confidence < 0.75 ||
    segment.docType === "unknown"
  );
}

/**
 * The document workflow up to record creation: classify, extract per segment,
 * then hand the typed results to ingestion (match, categorise, validate,
 * explain, route). Duplicate and size checks happen before this is called.
 */
export async function processDocumentText(
  input: ProcessDocumentInput,
): Promise<ProcessDocumentOutcome> {
  const { session, chatId, document } = input;
  const context = contextFromSession(session, { chatId, documentId: document.id });
  const mode: AgentMode = agentsEnabled() ? "model" : "deterministic";

  const classified = await runClassifier(context, {
    filename: input.filename,
    text: input.text,
  });
  await saveSegments(context, document.id, classified.segments);

  const known = classified.segments.filter(
    (segment): segment is ClassifiedSegment & { docType: DocType } => segment.docType !== "unknown",
  );
  const unknownSegments = classified.segments.length - known.length;

  if (!known.length) {
    const reason =
      "No readable business document was found in this file. The classifier marked every page as unknown.";
    await markUnreadable(session.schema, document.id, reason);
    return {
      records: [],
      summary:
        "I opened the file but could not find a supplier invoice, challan or statement line in it. It is in Exceptions so you can check the file. If it is a scan, paste the key details and I'll enter them.",
      segments: classified.segments.length,
      unknownSegments,
      mode,
      escalated: false,
    };
  }

  const results: ExtractionResult[] = [];
  const metaResults: IngestAgentMeta["results"] = [];
  let escalated = false;

  for (const segment of known) {
    const cached = await findCachedExtraction(context, document.id, segment.index);
    let payload: unknown;
    let envelope = cached?.envelope ?? null;
    let runId: string | null = null;

    const parsedCache = cached ? extractorSchema.safeParse(cached.payload) : null;
    if (parsedCache?.success) {
      payload = parsedCache.data;
    } else {
      const output = await runExtractor(context, {
        docType: segment.docType,
        text: segment.text,
        filename: input.filename,
        ...(input.overrides ? { overrides: input.overrides } : {}),
        ...(input.vendorStatus ? { vendorStatus: input.vendorStatus } : {}),
      });
      payload = output.result;
      envelope = output.envelope;
      runId = output.runId ?? null;
      if (output.escalated) escalated = true;
      await saveExtraction(context, {
        documentId: document.id,
        segmentIndex: segment.index,
        docType: segment.docType,
        payload: output.result,
        envelope: output.envelope,
        agentRunId: runId,
        sha256: null,
      });
    }

    const parsed = extractorSchema.safeParse(payload);
    if (!parsed.success) continue;
    const converted = toExtractionResults(parsed.data);
    const extractionEnvelope = envelope ?? {
      confidence: 0,
      warnings: [],
      reason: "No extraction envelope was stored.",
    };
    for (const result of converted) {
      results.push(result);
      metaResults.push({
        envelope: extractionEnvelope,
        extractionRunId: runId,
        segmentIndex: segment.index,
        explanation: null,
        suspectedQuality: segmentQualityIsSuspect(segment),
      });
    }
  }

  if (!results.length) {
    const reason =
      "The document was classified, but no invoice fields or statement lines could be read from its text.";
    await markUnreadable(session.schema, document.id, reason);
    return {
      records: [],
      summary:
        "I classified the file but could not read any invoice fields or statement lines. It is in Exceptions. If it is a scan, paste the supplier, GSTIN, document number and total and I'll enter them.",
      segments: classified.segments.length,
      unknownSegments,
      mode,
      escalated,
    };
  }

  const outcome = await ingestExtraction({
    session,
    chatId,
    document,
    results,
    ...(input.destinationOverride ? { destinationOverride: input.destinationOverride } : {}),
    agent: {
      context,
      mode,
      escalated,
      results: metaResults,
    },
  });

  await markSegmentsExtracted(context, document.id, "extracted");
  return {
    ...outcome,
    segments: classified.segments.length,
    unknownSegments,
    mode,
    escalated,
  };
}

export function agentToolChip(outcome: ProcessDocumentOutcome): {
  name: string;
  status: "ok" | "failed";
  summary: string;
} {
  const count = outcome.records.length;
  const mode = outcome.mode === "model" ? "AI agents" : "rule engine";
  return {
    name: "Document reader",
    status: outcome.escalated || count === 0 ? "failed" : "ok",
    summary:
      count === 0
        ? `No business record · ${mode}`
        : `${count} record${count === 1 ? "" : "s"} · classifier, extractor, matcher · ${mode}`,
  };
}
