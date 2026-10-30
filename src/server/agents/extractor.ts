import { z } from "zod";

import type { DocType, FieldMap } from "@/lib/types";
import { extractFromText } from "../extraction";
import { PROMPT_VERSIONS, extractorPrompt } from "./prompts";
import { runAgent, type AgentDefinition } from "./runner.server";
import type { AgentOutput, ExtractedRecord, ExtractorResult, RunContext } from "./types";

const DOC_TYPES = [
  "supplier_invoice",
  "credit_note",
  "purchase_order",
  "goods_receipt",
  "e_way_bill",
  "e_invoice",
  "bank_statement",
] as const;

const locationSchema = z.object({
  page: z.number().int().min(1).optional(),
  hint: z.string().max(200).optional(),
});

const extractedRecordSchema = z.object({
  docType: z.enum(DOC_TYPES),
  fields: z.record(z.unknown()),
  confidences: z.record(z.number().min(0).max(1)),
  title: z.string().min(1).max(200),
  vendorStatus: z.enum(["active", "cancelled", "suspended", "unknown"]).optional(),
  locations: z.record(locationSchema).optional(),
});

export const extractorSchema = z.object({
  results: z.array(extractedRecordSchema).max(400),
});

export interface ExtractorInput {
  docType: DocType;
  text: string;
  filename: string;
  overrides?: Record<string, number>;
  vendorStatus?: FieldMap["vendor_status"];
  examples?: unknown[];
}

function averageConfidence(results: ExtractedRecord[]): number {
  const values = results.flatMap((result) => Object.values(result.confidences));
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function fallback(input: ExtractorInput): AgentOutput<ExtractorResult> {
  const raw = extractFromText({
    text: input.text,
    filename: input.filename,
    ...(input.overrides ? { overrides: input.overrides } : {}),
    ...(input.vendorStatus ? { vendorStatus: input.vendorStatus } : {}),
  });
  const results: ExtractedRecord[] = raw.map((entry) => ({
    docType: entry.docType,
    fields: entry.fields,
    confidences: entry.confidences,
    title: entry.title,
    ...(entry.vendorStatus ? { vendorStatus: entry.vendorStatus } : {}),
    locations: { source: { hint: "text layer" } },
  }));

  const weakFields = new Set<string>();
  for (const result of results) {
    for (const [field, confidence] of Object.entries(result.confidences)) {
      if (confidence < 0.5) weakFields.add(field);
    }
  }

  return {
    result: { results },
    envelope: {
      confidence: averageConfidence(results),
      warnings: results.length
        ? [...weakFields]
            .slice(0, 5)
            .map((field) => `${field.replace(/_/g, " ")} was not read confidently.`)
        : ["No business fields could be read in this segment."],
      reason: `Deterministic text reader returned ${results.length} record${
        results.length === 1 ? "" : "s"
      }.`,
    },
  };
}

export const extractorAgent: AgentDefinition<ExtractorInput, ExtractorResult> = {
  id: "extraction",
  promptVersion: PROMPT_VERSIONS.extraction,
  schema: extractorSchema,
  fallback,
  buildPrompt: (input, context) =>
    extractorPrompt(context, {
      docType: input.docType,
      text: input.text,
      ...(input.examples ? { examples: input.examples } : {}),
    }),
};

export function runExtractor(
  context: RunContext,
  input: ExtractorInput,
): Promise<AgentOutput<ExtractorResult>> {
  return runAgent(extractorAgent, input, context);
}

export function toExtractionResults(output: ExtractorResult): {
  docType: DocType;
  fields: FieldMap;
  confidences: Record<string, number>;
  title: string;
  vendorStatus?: FieldMap["vendor_status"];
  locations?: Record<string, { page?: number | undefined; hint?: string | undefined }>;
}[] {
  return output.results.map((result) => ({
    docType: result.docType,
    fields: result.fields as FieldMap,
    confidences: result.confidences,
    title: result.title,
    ...(result.vendorStatus ? { vendorStatus: result.vendorStatus } : {}),
    ...(result.locations ? { locations: result.locations } : {}),
  }));
}
