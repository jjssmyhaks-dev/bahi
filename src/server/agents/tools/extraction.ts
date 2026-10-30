import { z } from "zod";

import { sql, sqlOne, table } from "../../db.server";
import { fieldGuide, packFor } from "../pack";
import { defineTool, fail, ok } from "./types";

const DOC_TYPE = z.enum([
  "supplier_invoice",
  "purchase_order",
  "goods_receipt",
  "e_way_bill",
  "e_invoice",
  "bank_statement",
]);

export const getExtractionSchemaTool = defineTool({
  name: "get_extraction_schema",
  description: "Return the pack's field schema and extraction hints for one document type.",
  kind: "read",
  agents: ["extraction"],
  schema: z.object({ doc_type: DOC_TYPE }),
  run: async (args, context) => {
    const pack = packFor(context.run);
    const fields = pack.fields[args.doc_type] ?? [];
    const guide = fieldGuide(pack, args.doc_type);
    return ok(
      {
        pack: pack.key,
        version: pack.version,
        docType: args.doc_type,
        fields: fields.map((field) => ({
          key: field.key,
          label: field.label,
          hint: field.hint,
        })),
        hints: pack.hints,
        guide,
      },
      `${fields.length} fields for ${args.doc_type}`,
    );
  },
});

export const getSimilarExamplesTool = defineTool({
  name: "get_similar_examples",
  description:
    "Find a few past corrected documents for the same vendor or layout, with the corrected field values.",
  kind: "read",
  agents: ["extraction"],
  schema: z.object({
    doc_type: DOC_TYPE,
    vendor_name: z.string().max(160).optional(),
    limit: z.number().int().min(1).max(5).optional(),
  }),
  run: async (args, context) => {
    const limit = args.limit ?? 3;
    const rows = await sql<{
      record_id: string;
      title: string;
      vendor: string | null;
      field: string;
      new_value: string;
    }>(
      `select c.record_id, r.title, r.fields->>'vendor_name' as vendor, c.field, c.new_value
         from ${table(context.run.schema, "corrections")} c
         join ${table(context.run.schema, "records")} r on r.id = c.record_id
        where r.doc_type = $1
          and coalesce(c.new_value, '') <> ''
          and c.one_off = false
          and ($2::text is null or lower(coalesce(r.fields->>'vendor_name', '')) like '%' || lower($2) || '%')
        order by c.created_at desc
        limit 60`,
      [args.doc_type, args.vendor_name ?? null],
    );

    const examples = new Map<
      string,
      {
        recordId: string;
        title: string;
        vendor: string | null;
        correctedFields: Record<string, string>;
      }
    >();
    for (const row of rows) {
      const existing = examples.get(row.record_id);
      if (existing) {
        existing.correctedFields[row.field] = row.new_value;
        continue;
      }
      if (examples.size >= limit) continue;
      examples.set(row.record_id, {
        recordId: row.record_id,
        title: row.title,
        vendor: row.vendor,
        correctedFields: { [row.field]: row.new_value },
      });
    }

    return ok(
      { examples: [...examples.values()] },
      `${examples.size} corrected example${examples.size === 1 ? "" : "s"}`,
    );
  },
});

/**
 * Cropping needs a page raster, which this build does not create. The tool
 * returns a typed unavailable result so the agent falls back to OCR text rather
 * than promising a zoom it cannot produce.
 */
export const getFieldCropTool = defineTool({
  name: "get_field_crop",
  description:
    "Return a zoomed image of a page region for a second pass on a low-confidence field.",
  kind: "read",
  agents: ["extraction"],
  schema: z.object({
    document_id: z.string().uuid().optional(),
    page: z.number().int().min(1).optional(),
    field: z.string().max(80).optional(),
  }),
  run: async (_args, _context) =>
    fail(
      "unavailable",
      "Page image crops are not available in this build. Use get_ocr_text for the page and read the field from its printed label.",
    ),
});

export const getOcrTextTool = defineTool({
  name: "get_ocr_text",
  description:
    "Return machine-read text for one page of a file, with line positions, as a hint alongside the image.",
  kind: "read",
  agents: ["extraction"],
  schema: z.object({
    document_id: z.string().uuid().optional(),
    page: z.number().int().min(1).optional(),
    max_chars: z.number().int().min(200).max(12_000).optional(),
  }),
  run: async (args, context) => {
    const documentId = args.document_id ?? context.run.documentId;
    if (!documentId) return fail("not_found", "No document is attached to this run.");
    const row = await sqlOne<{ id: string; filename: string; extracted_text: string | null }>(
      `select id, filename, extracted_text from ${table(context.run.schema, "documents")}
        where id = $1`,
      [documentId],
    );
    if (!row) return fail("not_found", "That document is not in this workspace.");
    if (!row.extracted_text?.trim()) return fail("unavailable", "This file has no readable text.");

    const pages = row.extracted_text.split("\f");
    const pageNumber = args.page ?? 1;
    const page = pages[pageNumber - 1];
    if (!page) return fail("not_found", `Page ${pageNumber} is not in this file.`);

    const maxChars = args.max_chars ?? 6_000;
    const text = page.trim();
    let offset = 0;
    const lines = text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .slice(0, 200)
      .map((line, index) => {
        const entry = { line: index + 1, offset, text: line.trim().slice(0, 300) };
        offset += line.length + 1;
        return entry;
      });

    return ok(
      {
        documentId: row.id,
        filename: row.filename,
        page: pageNumber,
        pageCount: pages.length,
        text: text.slice(0, maxChars),
        truncated: text.length > maxChars,
        lines,
      },
      `${lines.length} lines read from page ${pageNumber}`,
    );
  },
});

export const EXTRACTION_TOOLS = [
  getExtractionSchemaTool,
  getSimilarExamplesTool,
  getFieldCropTool,
  getOcrTextTool,
];
