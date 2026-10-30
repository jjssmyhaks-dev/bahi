import { z } from "zod";

import type { DocType, FieldMap } from "@/lib/types";
import { PROMPT_VERSIONS, mapperPrompt } from "./prompts";
import { runAgent, type AgentDefinition } from "./runner.server";
import { getMapping, saveMapping } from "./store.server";
import type { AgentOutput, ColumnMapping, MapperResult, RunContext } from "./types";

const columnSchema = z.object({
  column: z.string().min(1).max(120),
  field: z.string().nullable(),
  fixedValue: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export const mapperSchema = z.object({
  columns: z.array(columnSchema).max(80),
  unmapped: z.array(z.string()).max(80),
});

const storedMappingSchema = z.object({
  columns: z.array(
    z.object({
      column: z.string(),
      field: z.string().nullable().optional(),
      fixedValue: z.string().nullable().optional(),
      confidence: z.number().optional(),
    }),
  ),
});

export interface MapperInput {
  headers: string[];
  sampleRows: string[][];
  fields: string[];
  docType: DocType;
}

interface Synonym {
  pattern: RegExp;
  field: string | null;
  fixedValue?: string;
}

const SYNONYMS: Synonym[] = [
  { pattern: /^date$|invoice date|bill date|txn date|transaction date/i, field: "invoice_date" },
  { pattern: /document type|voucher type|^type$/i, field: "doc_type" },
  { pattern: /^gstin$|gstin|gst no|gst number/i, field: "vendor_gstin" },
  { pattern: /cgst|central gst/i, field: "cgst" },
  { pattern: /sgst|state gst/i, field: "sgst" },
  { pattern: /igst|integrated gst/i, field: "igst" },
  { pattern: /taxable/i, field: "taxable_value" },
  { pattern: /^total$|invoice total|grand total|amount$/i, field: "total" },
  { pattern: /reference|ref no|utr|cheque/i, field: "reference_number" },
  { pattern: /invoice|bill no|document no|doc no|voucher no/i, field: "invoice_number" },
  { pattern: /source/i, field: null, fixedValue: "Bahi" },
  { pattern: /ledger|account head/i, field: "ledger" },
  { pattern: /category/i, field: "category" },
  { pattern: /narration|description|particulars/i, field: "narration" },
  { pattern: /vendor|supplier|party|payee/i, field: "vendor_name" },
];

function isAvailable(input: MapperInput, field: string | null): boolean {
  if (!field) return true;
  return field === "doc_type" || input.fields.includes(field);
}

export function deterministicColumns(input: MapperInput): MapperResult {
  const columns: ColumnMapping[] = input.headers.map((header) => {
    const synonym = SYNONYMS.find((entry) => entry.pattern.test(header.trim()));
    if (!synonym) {
      return { column: header, field: null, fixedValue: null, confidence: 0.2 };
    }
    const nextField =
      synonym.field === "vendor_name" && input.docType === "bank_statement"
        ? "narration"
        : synonym.field;
    if (!isAvailable(input, nextField)) {
      return { column: header, field: null, fixedValue: null, confidence: 0.25 };
    }
    return {
      column: header,
      field: nextField,
      fixedValue: synonym.fixedValue ?? null,
      confidence: synonym.fixedValue ? 0.97 : 0.95,
    };
  });

  return {
    columns,
    unmapped: columns
      .filter((column) => !column.field && !column.fixedValue)
      .map((column) => column.column),
  };
}

function fallback(input: MapperInput): AgentOutput<MapperResult> {
  const result = deterministicColumns(input);
  const mapped = result.columns.filter((column) => column.field || column.fixedValue).length;
  return {
    result,
    envelope: {
      confidence: input.headers.length ? mapped / input.headers.length : 0,
      warnings: result.unmapped.length
        ? [`These columns have no matching field: ${result.unmapped.join(", ")}.`]
        : [],
      reason: `${mapped} of ${input.headers.length} columns matched a field by header text.`,
    },
  };
}

export const mapperAgent: AgentDefinition<MapperInput, MapperResult> = {
  id: "destination_mapper",
  promptVersion: PROMPT_VERSIONS.destination_mapper,
  schema: mapperSchema,
  fallback,
  buildPrompt: (input, context) => mapperPrompt(context, input),
};

export interface MapperOutcome {
  output: AgentOutput<MapperResult>;
  confirmed: boolean;
}

function applyHeaders(mapping: MapperResult, headers: string[]): MapperResult {
  const byHeader = new Map(mapping.columns.map((column) => [column.column.toLowerCase(), column]));
  const columns: ColumnMapping[] = headers.map((header) => {
    const found = byHeader.get(header.toLowerCase());
    return found ?? { column: header, field: null, fixedValue: null, confidence: 0.2 };
  });
  return {
    columns,
    unmapped: columns
      .filter((column) => !column.field && !column.fixedValue)
      .map((column) => column.column),
  };
}

/**
 * Reuses a confirmed mapping silently. The first time a sheet shape is seen it
 * proposes a mapping and stores it as proposed; the caller must ask the user.
 */
export async function runMapper(
  context: RunContext,
  input: MapperInput & { scopeKey: string },
): Promise<MapperOutcome> {
  const existing = await getMapping(context.schema, "sheet_columns", input.scopeKey);
  if (existing?.status === "confirmed") {
    const parsed = storedMappingSchema.safeParse(existing.mapping);
    if (parsed.success) {
      const mapped = parsed.data.columns.map((column) => ({
        column: column.column,
        field: column.field ?? null,
        fixedValue: column.fixedValue ?? null,
        confidence: column.confidence ?? 0.99,
      }));
      const result = applyHeaders({ columns: mapped, unmapped: [] }, input.headers);
      return {
        confirmed: true,
        output: {
          result,
          envelope: {
            confidence: 0.99,
            warnings: result.unmapped.length
              ? [
                  `These columns are new and have no confirmed mapping: ${result.unmapped.join(", ")}.`,
                ]
              : [],
            reason: "Reused the confirmed column mapping for this sheet.",
          },
        },
      };
    }
  }

  const output = await runAgent(mapperAgent, input, context);
  const result = applyHeaders(output.result, input.headers);
  await saveMapping(context.schema, {
    kind: "sheet_columns",
    scopeKey: input.scopeKey,
    mapping: { columns: result.columns },
    status: "proposed",
    source: "agent",
    ...(output.runId ? { evidenceCount: 1 } : {}),
  });

  return {
    confirmed: false,
    output: {
      ...output,
      result,
      envelope: {
        ...output.envelope,
        warnings: [
          ...output.envelope.warnings,
          ...(result.unmapped.length
            ? [`Ask the user how to map: ${result.unmapped.join(", ")}.`]
            : []),
        ],
      },
    },
  };
}

export async function confirmMapper(
  context: RunContext,
  scopeKey: string,
  mapping: MapperResult,
): Promise<void> {
  await saveMapping(context.schema, {
    kind: "sheet_columns",
    scopeKey,
    mapping: { columns: mapping.columns },
    status: "confirmed",
    source: "user",
    confirmedBy: context.userId,
  });
}
