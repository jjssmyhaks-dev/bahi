import { randomBytes } from "node:crypto";

import type { RecordRow, SessionUser } from "@/lib/types";
import { adminClient } from "./auth.server";
import { sql, sqlOne, table } from "./db.server";
import type { IncomingFile } from "./documents.server";

const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024;
const BUCKET = "documents";

interface TemplateColumn {
  column: string;
  header: string;
  field: string | null;
}

export interface ExcelTemplate {
  id: string;
  filename: string;
  sheetName: string;
  headerRow: number;
  columns: TemplateColumn[];
  createdAt: string;
}

const FIELD_HEADERS: Record<string, string[]> = {
  invoice_date: ["date", "invoice date", "bill date", "voucher date"],
  doc_type: ["document type", "doc type", "type", "voucher type"],
  vendor_name: ["party", "vendor", "supplier", "party name", "vendor name", "supplier name"],
  vendor_gstin: ["gstin", "supplier gstin", "vendor gstin", "gstin/uin"],
  invoice_number: [
    "document no.",
    "document no",
    "invoice number",
    "invoice no",
    "bill no",
    "voucher no",
  ],
  po_number: ["po number", "purchase order", "po no."],
  irn: ["irn", "invoice reference number"],
  taxable_value: ["taxable value", "taxable", "taxable amount"],
  cgst: ["cgst", "central tax"],
  sgst: ["sgst", "state tax"],
  igst: ["igst", "integrated tax"],
  total: ["total", "invoice total", "amount", "gross total"],
  ledger: ["ledger", "expense ledger", "account"],
  category: ["category", "expense category"],
  reference_number: ["reference", "reference number", "ref no"],
  narration: ["narration", "description", "remarks"],
};

const normalHeader = (value: string) =>
  value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

function fieldForHeader(header: string): string | null {
  const normalised = normalHeader(header);
  for (const [field, aliases] of Object.entries(FIELD_HEADERS)) {
    if (aliases.includes(normalised)) return field;
  }
  return null;
}

async function readTemplate(buffer: Buffer): Promise<{
  workbook: import("exceljs").Workbook;
  sheet: import("exceljs").Worksheet;
  headerRow: number;
  columns: TemplateColumn[];
}> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("The template workbook has no sheets.");

  let headerRow = 0;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (headerRow) return;
    const filled = (row.values as unknown[]).slice(1).filter((cell) => String(cell ?? "").trim());
    if (filled.length >= 2) headerRow = rowNumber;
  });
  if (!headerRow) throw new Error("The template has no header row with at least two labels.");

  const row = sheet.getRow(headerRow);
  const columns: TemplateColumn[] = [];
  row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    const header = String(cell.value ?? "").trim();
    if (!header) return;
    columns.push({
      column: sheet.getColumn(columnNumber).letter,
      header,
      field: fieldForHeader(header),
    });
  });
  return { workbook, sheet, headerRow, columns };
}

function cellValue(record: RecordRow, field: string): string | number | Date | null {
  const fields = record.fields;
  if (field === "doc_type") return record.docType.replace(/_/g, " ");
  if (field === "source") return record.document?.filename ?? "Chat upload";
  if (field === "invoice_date") {
    const raw = String(fields.invoice_date ?? "");
    const date = new Date(raw);
    return raw && !Number.isNaN(date.getTime()) ? date : raw || null;
  }
  if (["taxable_value", "cgst", "sgst", "igst", "total"].includes(field)) {
    const value = Number(fields[field] ?? 0);
    return Number.isFinite(value) ? value : 0;
  }
  const value = fields[field];
  if (value === undefined || value === null) return null;
  return String(value);
}

function toTemplate(row: Record<string, unknown>): ExcelTemplate {
  const mapping = row["mapping"] as { columns?: TemplateColumn[] } | null;
  return {
    id: String(row["id"]),
    filename: String(row["filename"]),
    sheetName: String(row["sheet_name"]),
    headerRow: Number(row["header_row"] ?? 1),
    columns: Array.isArray(mapping?.columns) ? mapping.columns : [],
    createdAt: new Date(String(row["created_at"])).toISOString(),
  };
}

export async function uploadExcelTemplate(
  session: SessionUser,
  file: IncomingFile,
): Promise<ExcelTemplate> {
  if (session.role === "viewer") throw new Error("Your role cannot change the Excel template.");
  const base64 = file.base64.includes(",")
    ? file.base64.slice(file.base64.indexOf(",") + 1)
    : file.base64;
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) throw new Error("The template file is empty.");
  if (buffer.length > MAX_TEMPLATE_BYTES) throw new Error("The template is larger than 10 MB.");
  if (!/\.xlsx$/i.test(file.name)) throw new Error("Save the template as .xlsx and upload that.");

  const { sheet, headerRow, columns } = await readTemplate(buffer);
  const id = randomBytes(8).toString("hex");
  const filename = file.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "template.xlsx";
  const storagePath = `bahi/${session.tenantId}/templates/${id}/${filename}`;
  const { error } = await adminClient().storage.from(BUCKET).upload(storagePath, buffer, {
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    upsert: false,
  });
  if (error) throw new Error(`The template could not be stored: ${error.message}`);

  const inserted = await sqlOne<Record<string, unknown>>(
    `insert into ${table(session.schema, "excel_templates")}
      (filename, storage_path, sheet_name, header_row, mapping)
     values ($1, $2, $3, $4, $5::jsonb) returning *`,
    [
      filename,
      storagePath,
      sheet.name,
      headerRow,
      JSON.stringify({
        columns,
        recognised: columns.filter((column) => column.field).length,
      }),
    ],
  );
  if (!inserted) throw new Error("The template could not be recorded.");
  return toTemplate(inserted);
}

export async function activeExcelTemplate(session: SessionUser): Promise<ExcelTemplate | null> {
  try {
    const row = await sqlOne<Record<string, unknown>>(
      `select * from ${table(session.schema, "excel_templates")}
        order by created_at desc limit 1`,
    );
    return row ? toTemplate(row) : null;
  } catch {
    return null;
  }
}

export async function fillExcelTemplate(
  session: SessionUser,
  records: RecordRow[],
): Promise<{ base64: string; filename: string; rows: number } | null> {
  const template = await activeExcelTemplate(session);
  if (!template || !records.length) return null;
  const row = await sqlOne<{ storage_path: string }>(
    `select storage_path from ${table(session.schema, "excel_templates")} where id = $1`,
    [template.id],
  );
  if (!row?.storage_path) return null;
  const download = await adminClient().storage.from(BUCKET).download(row.storage_path);
  if (download.error || !download.data) return null;

  const buffer = Buffer.from(await download.data.arrayBuffer());
  const { workbook, sheet, headerRow, columns } = await readTemplate(buffer);
  const mapped = columns.filter((column) => column.field);

  const startRow = headerRow + 1;
  records.forEach((record, index) => {
    const target = sheet.getRow(startRow + index);
    for (const column of mapped) {
      const position = sheet.getColumn(column.column).number;
      target.getCell(position).value = cellValue(record, column.field!);
    }
    target.commit();
  });

  const output = await workbook.xlsx.writeBuffer();
  return {
    base64: Buffer.from(output).toString("base64"),
    filename: `bahi-filled-${new Date().toISOString().slice(0, 10)}.xlsx`,
    rows: records.length,
  };
}
