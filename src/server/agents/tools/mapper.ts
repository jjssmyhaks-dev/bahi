import { z } from "zod";

import type { DocType } from "@/lib/types";
import { sql, sqlOne, table } from "../../db.server";
import { packFor } from "../pack";
import { getMapping } from "../store.server";
import { defineTool, ok } from "./types";

const TEMPLATE_HEADERS = [
  "Date",
  "Document type",
  "Vendor / narration",
  "GSTIN",
  "Document no.",
  "Taxable value",
  "CGST",
  "SGST",
  "IGST",
  "Total",
  "Source",
];

export const inspectSheetHeadersTool = defineTool({
  name: "inspect_sheet_headers",
  description:
    "Read only the header row and a few sample rows of the connected sheet or uploaded template.",
  kind: "read",
  agents: ["destination_mapper"],
  schema: z.object({
    connection_id: z.string().uuid().optional(),
    scope_key: z.string().max(160).optional(),
    sample_rows: z.number().int().min(0).max(5).optional(),
  }),
  run: async (args, context) => {
    const limit = args.sample_rows ?? 3;
    const connection = args.connection_id
      ? await sqlOne<{ id: string; spreadsheet_name: string; sheet_name: string }>(
          `select id, spreadsheet_name, sheet_name from ${table(context.run.schema, "sheet_connections")}
            where id = $1`,
          [args.connection_id],
        )
      : await sqlOne<{ id: string; spreadsheet_name: string; sheet_name: string }>(
          `select id, spreadsheet_name, sheet_name from ${table(context.run.schema, "sheet_connections")}
            where provider = 'google_sheets' order by created_at asc limit 1`,
        );
    if (!connection) {
      return ok(
        {
          source: "standard_template",
          connectionId: null,
          sheetName: "Entries",
          headers: TEMPLATE_HEADERS,
          sampleRows: [],
        },
        "Standard template headers",
      );
    }

    const rows = await sql<{ values: Record<string, unknown> }>(
      `select values from ${table(context.run.schema, "sheet_rows")}
        where connection_id = $1 order by row_number asc limit $2`,
      [connection.id, limit],
    );
    const headers = rows.length ? Object.keys(rows[0]?.values ?? {}) : TEMPLATE_HEADERS;
    const sampleRows = rows.map((row) => headers.map((header) => row.values[header] ?? null));
    return ok(
      {
        source: rows.length ? "sheet_rows" : "standard_template",
        connectionId: connection.id,
        sheetName: connection.sheet_name,
        spreadsheetName: connection.spreadsheet_name,
        headers,
        sampleRows,
      },
      `${headers.length} columns in ${connection.sheet_name}`,
    );
  },
});

export const getRecordFieldListTool = defineTool({
  name: "get_record_field_list",
  description: "List the fields available on a record type, with short descriptions.",
  kind: "read",
  agents: ["destination_mapper"],
  schema: z.object({
    doc_type: z
      .enum([
        "supplier_invoice",
        "credit_note",
        "purchase_order",
        "goods_receipt",
        "e_way_bill",
        "e_invoice",
        "bank_statement",
      ])
      .optional(),
  }),
  run: async (args, context) => {
    const docType: DocType = args.doc_type ?? "supplier_invoice";
    const pack = packFor(context.run);
    const fields = (pack.fields[docType] ?? []).map((field) => ({
      key: field.key,
      label: field.label,
      description: field.hint,
    }));
    return ok({ docType, fields }, `${fields.length} fields for ${docType}`);
  },
});

export const getConfirmedMappingTool = defineTool({
  name: "get_confirmed_mapping",
  description: "Return a previously confirmed column mapping for this sheet or template.",
  kind: "read",
  agents: ["destination_mapper"],
  schema: z.object({ scope_key: z.string().min(1).max(160) }),
  run: async (args, context) => {
    const mapping = await getMapping(context.run.schema, "sheet_columns", args.scope_key);
    if (!mapping || mapping.status !== "confirmed") {
      return ok({ mapping: null }, "No confirmed mapping for that sheet");
    }
    return ok({ mapping: mapping.mapping, mappingId: mapping.id }, "Confirmed mapping found");
  },
});

/** The mapping card is confirmed by the approval step, never by an agent tool. */
export const MAPPER_TOOLS = [
  inspectSheetHeadersTool,
  getRecordFieldListTool,
  getConfirmedMappingTool,
];
