import type { SessionUser } from "@/lib/types";
import { sql, sqlOne, table } from "./db.server";

export interface Gstr2bLine {
  period: string;
  supplierGstin: string;
  supplierName: string | null;
  invoiceNumber: string;
  invoiceDate: string | null;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  itcStatus: string | null;
}

export interface Gstr2bImportResult {
  period: string;
  imported: number;
  matched: number;
  mismatched: number;
  missingInBooks: number;
}

export interface Gstr2bImportSummary extends Gstr2bImportResult {
  importedAt: string;
}

const number = (value: unknown): number => {
  const parsed = Number(String(value ?? "").replace(/[₹,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

const text = (value: unknown): string => String(value ?? "").trim();

function pick(record: Record<string, unknown>, keys: string[]): unknown {
  const lower = new Map(Object.keys(record).map((key) => [key.toLowerCase(), key]));
  for (const key of keys) {
    const actual = lower.get(key.toLowerCase());
    if (actual !== undefined && record[actual] !== undefined && record[actual] !== null) {
      return record[actual];
    }
  }
  return undefined;
}

function isoDate(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const dmy = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  const iso = dmy ? `${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}` : raw;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : iso.slice(0, 10);
}

function periodFromDate(value: string | null): string | null {
  return value && /^\d{4}-\d{2}/.test(value) ? value.slice(0, 7) : null;
}

/** Splits CSV text, honouring quoted cells and doubled quotes. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === "," || char === ";") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

function normaliseJsonLine(
  raw: Record<string, unknown>,
  fallbackPeriod: string | null,
): Gstr2bLine | null {
  const supplierGstin = text(
    pick(raw, ["supplier_gstin", "ctin", "gstin", "supplierGstin", "recipient_gstin"]),
  ).toUpperCase();
  const invoiceNumber = text(pick(raw, ["invoice_number", "inum", "invoice_no", "doc_number"]));
  if (!supplierGstin || !invoiceNumber) return null;
  const invoiceDate = isoDate(pick(raw, ["invoice_date", "dt", "date", "doc_date"]));
  const period =
    text(pick(raw, ["period", "ret_period", "tax_period"])) ||
    periodFromDate(invoiceDate) ||
    fallbackPeriod ||
    new Date().toISOString().slice(0, 7);
  const taxable = number(pick(raw, ["taxable_value", "txval", "taxable", "taxable_amount"]));
  const cgst = number(pick(raw, ["cgst", "camt", "cgst_amount"]));
  const sgst = number(pick(raw, ["sgst", "samt", "sgst_amount"]));
  const igst = number(pick(raw, ["igst", "iamt", "igst_amount"]));
  const total =
    number(pick(raw, ["total", "invoice_value", "val", "invoice_total"])) ||
    Math.round((taxable + cgst + sgst + igst) * 100) / 100;
  return {
    period: period.slice(0, 7),
    supplierGstin,
    supplierName: text(pick(raw, ["supplier_name", "trdnm", "trade_name", "legal_name"])) || null,
    invoiceNumber,
    invoiceDate,
    taxable,
    cgst,
    sgst,
    igst,
    total,
    itcStatus: text(pick(raw, ["itc_status", "itcavl", "itc_availability"])) || null,
  };
}

function invoiceBundles(value: unknown, output: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) invoiceBundles(entry, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const invoices = pick(record, ["inv", "invoices", "docs", "entries", "doclist", "b2b"]);
  if (Array.isArray(invoices)) {
    const supplier = pick(record, ["supplier_gstin", "ctin", "gstin"]);
    const supplierName = pick(record, ["supplier_name", "trdnm", "trade_name", "legal_name"]);
    for (const invoice of invoices) {
      if (!invoice || typeof invoice !== "object") continue;
      // Portal groups wrap their invoice list one level deeper in each group.
      if (
        Array.isArray(
          pick(invoice as Record<string, unknown>, [
            "inv",
            "invoices",
            "docs",
            "entries",
            "doclist",
            "b2b",
          ]),
        )
      ) {
        invoiceBundles(invoice, output);
        continue;
      }
      const row = invoice as Record<string, unknown>;
      output.push({
        ...row,
        ...(supplier !== undefined && pick(row, ["ctin", "supplier_gstin", "gstin"]) === undefined
          ? { supplier_gstin: supplier }
          : {}),
        ...(supplierName !== undefined &&
        pick(row, ["supplier_name", "trdnm", "trade_name", "legal_name"]) === undefined
          ? { supplier_name: supplierName }
          : {}),
      });
    }
    return;
  }
  for (const child of Object.values(record)) {
    if (Array.isArray(child) || (child && typeof child === "object")) invoiceBundles(child, output);
  }
}

export function parseGstr2b(
  input: string,
  filename: string,
  fallbackPeriod?: string,
): Gstr2bLine[] {
  const period = fallbackPeriod?.slice(0, 7) ?? null;
  if (
    /\.csv$|\.tsv$/i.test(filename) ||
    (!input.trim().startsWith("{") && !input.trim().startsWith("["))
  ) {
    const rows = parseCsv(input);
    if (rows.length < 2) return [];
    const header = rows[0]!.map((cell) => cell.trim().toLowerCase());
    const aliases: Record<string, string[]> = {
      supplier_gstin: ["supplier_gstin", "ctin", "gstin", "supplier gstin"],
      supplier_name: ["supplier_name", "trade_name", "supplier name"],
      invoice_number: [
        "invoice_number",
        "invoice number",
        "invoice no",
        "invoice_no",
        "inum",
        "document number",
      ],
      invoice_date: ["invoice_date", "invoice date", "date", "dt"],
      taxable: ["taxable_value", "taxable", "txval", "taxable value"],
      cgst: ["cgst", "camt", "cgst amount"],
      sgst: ["sgst", "samt", "sgst amount"],
      igst: ["igst", "iamt", "igst amount"],
      total: ["total", "invoice value", "invoice_value", "val", "invoice total"],
      period: ["period", "tax period", "return period"],
      itc_status: ["itc_status", "itc status", "itc availability"],
    };
    const index = (key: string) => {
      for (const alias of aliases[key] ?? [key]) {
        const found = header.indexOf(alias);
        if (found >= 0) return found;
      }
      return -1;
    };
    const at = (row: string[], key: string) => {
      const position = index(key);
      return position >= 0 ? row[position] : undefined;
    };
    const lines: Gstr2bLine[] = [];
    for (const row of rows.slice(1)) {
      const raw: Record<string, unknown> = {
        supplier_gstin: at(row, "supplier_gstin"),
        supplier_name: at(row, "supplier_name"),
        invoice_number: at(row, "invoice_number"),
        invoice_date: at(row, "invoice_date"),
        taxable_value: at(row, "taxable"),
        cgst: at(row, "cgst"),
        sgst: at(row, "sgst"),
        igst: at(row, "igst"),
        total: at(row, "total"),
        period: at(row, "period"),
        itc_status: at(row, "itc_status"),
      };
      const line = normaliseJsonLine(raw, period);
      if (line) lines.push(line);
    }
    return lines;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("That file is not valid JSON or CSV.");
  }
  const bundles: Record<string, unknown>[] = [];
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (entry && typeof entry === "object") bundles.push(entry as Record<string, unknown>);
    }
  } else if (parsed && typeof parsed === "object") {
    invoiceBundles(parsed, bundles);
    if (!bundles.length) bundles.push(parsed as Record<string, unknown>);
  }
  return bundles
    .map((entry) => normaliseJsonLine(entry, period))
    .filter((line): line is Gstr2bLine => line !== null);
}

function tolerance(total: number): number {
  return Math.max(100, total * 0.01);
}

interface BookRecord {
  id: string;
  invoiceNumber: string;
  vendorGstin: string;
  total: number;
  evidence: Record<string, unknown>;
}

export async function importGstr2b(
  session: SessionUser,
  file: { name: string; content: string; period?: string },
): Promise<Gstr2bImportResult> {
  if (session.role === "viewer") {
    throw new Error("Your role cannot import GSTR-2B data.");
  }
  const lines = parseGstr2b(file.content, file.name, file.period);
  if (!lines.length) {
    throw new Error(
      "No GSTR-2B invoices were found. Upload the JSON from the GST portal or a CSV with supplier GSTIN, invoice number and total.",
    );
  }
  const period =
    file.period?.slice(0, 7) ??
    lines
      .map((line) => line.period)
      .sort()
      .at(-1) ??
    new Date().toISOString().slice(0, 7);

  const records = await sql<{
    id: string;
    invoice_number: string | null;
    vendor_gstin: string | null;
    total: string | null;
    evidence: Record<string, unknown> | null;
  }>(
    `select id, fields->>'invoice_number' as invoice_number,
            fields->>'vendor_gstin' as vendor_gstin, fields->>'total' as total, evidence
       from ${table(session.schema, "records")}
      where doc_type in ('supplier_invoice', 'credit_note', 'e_invoice')
        and status <> 'rejected'`,
  );
  const books = new Map<string, BookRecord>();
  for (const record of records) {
    if (!record.invoice_number || !record.vendor_gstin) continue;
    const key = `${record.vendor_gstin.trim().toUpperCase()}|${record.invoice_number.trim().toLowerCase()}`;
    if (!books.has(key)) {
      books.set(key, {
        id: record.id,
        invoiceNumber: record.invoice_number,
        vendorGstin: record.vendor_gstin,
        total: Number(record.total ?? 0),
        evidence: record.evidence ?? {},
      });
    }
  }

  const result: Gstr2bImportResult = {
    period,
    imported: 0,
    matched: 0,
    mismatched: 0,
    missingInBooks: 0,
  };

  for (const line of lines) {
    const key = `${line.supplierGstin}|${line.invoiceNumber.toLowerCase()}`;
    const book = books.get(key);
    let status: "matched" | "mismatch" | "missing_in_books" = "missing_in_books";
    let recordId: string | null = null;
    let reason = "This invoice is in GSTR-2B but no matching book record exists.";
    if (book) {
      recordId = book.id;
      const difference = Math.abs(book.total - line.total);
      if (difference <= tolerance(line.total)) {
        status = "matched";
        reason = `Matched GSTR-2B ${period}.`;
        result.matched += 1;
      } else {
        status = "mismatch";
        reason = `GSTR-2B shows ₹${line.total.toFixed(2)} but the books show ₹${book.total.toFixed(2)}.`;
        result.mismatched += 1;
      }
      await sql(
        `update ${table(session.schema, "records")}
            set evidence = coalesce(evidence, '{}'::jsonb) || $2::jsonb
          where id = $1`,
        [
          book.id,
          JSON.stringify({
            gstr2bMatch: status === "matched" ? "matched" : "mismatch",
            gstr2bPeriod: period,
            gstr2bReason: reason,
          }),
        ],
      );
    } else {
      result.missingInBooks += 1;
    }

    await sql(
      `insert into ${table(session.schema, "gstr2b_lines")}
        (period, supplier_gstin, supplier_name, invoice_number, invoice_date, taxable_value,
         cgst, sgst, igst, total, itc_status, record_id, match_status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (period, supplier_gstin, invoice_number) do update
         set supplier_name = excluded.supplier_name,
             invoice_date = excluded.invoice_date,
             taxable_value = excluded.taxable_value,
             cgst = excluded.cgst, sgst = excluded.sgst, igst = excluded.igst,
             total = excluded.total, itc_status = excluded.itc_status,
             record_id = excluded.record_id, match_status = excluded.match_status`,
      [
        line.period,
        line.supplierGstin,
        line.supplierName,
        line.invoiceNumber,
        line.invoiceDate,
        line.taxable,
        line.cgst,
        line.sgst,
        line.igst,
        line.total,
        line.itcStatus,
        recordId,
        status,
      ],
    );
    result.imported += 1;
  }

  await sql(
    `insert into ${table(session.schema, "activity")} (user_id, action, detail)
     values ($1, 'gstr2b.imported', $2::jsonb)`,
    [session.userId, JSON.stringify(result)],
  );

  return result;
}

export async function latestGstr2bImport(
  session: SessionUser,
): Promise<Gstr2bImportSummary | null> {
  const row = await sqlOne<{ detail: Gstr2bImportResult; created_at: Date }>(
    `select detail, created_at from ${table(session.schema, "activity")}
      where action = 'gstr2b.imported' order by created_at desc limit 1`,
  );
  if (!row) return null;
  return { ...row.detail, importedAt: new Date(row.created_at).toISOString() };
}
