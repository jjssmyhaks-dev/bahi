import type { Destination, FieldMap, RecordRow } from "@/lib/types";
import { formatAmount, formatDate } from "@/lib/format";
import { sql, sqlOne, table } from "./db.server";

export interface TallyLedgerEntry {
  ledger: string;
  amount: number;
  direction: "debit" | "credit";
}

export interface TallyInventoryAllocation {
  item: string;
  quantity: number;
  rate: number;
  amount: number;
  unit?: string;
  hsn?: string;
}

export interface TallyVoucherPayload {
  voucherType: string;
  date: string;
  narration: string;
  party: string;
  company: string;
  entries: TallyLedgerEntry[];
  inventory?: TallyInventoryAllocation[];
  total: number;
  gst: { cgst: number; sgst: number; igst: number };
  voucherNumber?: string;
  reference?: string;
  partyGstin?: string;
  isOptional?: boolean;
}

const escapeXml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

function tallyDate(iso: string | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "20260101";
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function inventoryAllocations(fields: FieldMap): TallyInventoryAllocation[] {
  const lines = Array.isArray(fields.line_items) ? fields.line_items : [];
  return lines
    .map((line) => {
      const quantity = Number(line.quantity ?? 1);
      const amount = Number(line.amount ?? quantity * Number(line.rate ?? 0));
      return {
        item: String(line.description ?? "").trim() || "Item",
        quantity: Number.isFinite(quantity) ? quantity : 1,
        rate: Number(line.rate ?? (quantity ? amount / quantity : amount)),
        amount: Number.isFinite(amount) ? amount : 0,
        ...(line.unit ? { unit: String(line.unit) } : {}),
        ...(line.hsn ? { hsn: String(line.hsn) } : {}),
      };
    })
    .filter((allocation) => allocation.amount !== 0);
}

export function buildTallyVoucher(record: RecordRow, company: string): TallyVoucherPayload {
  const f = record.fields;
  const total = Number(f.total ?? 0);
  const taxable = Number(f.taxable_value ?? 0);
  const cgst = Number(f.cgst ?? 0);
  const sgst = Number(f.sgst ?? 0);
  const igst = Number(f.igst ?? 0);
  const roundOff = Number(f.round_off ?? 0);
  const isBank = record.docType === "bank_statement";
  const reference = String(
    f.invoice_number ?? f.po_number ?? f.challan_number ?? f.reference_number ?? "",
  ).trim();
  const partyGstin = String(f.vendor_gstin ?? "").trim();

  if (isBank) {
    const amount = Number(f.debit ?? 0) + Number(f.credit ?? 0);
    const direction = Number(f.debit ?? 0) > 0 ? "credit" : "debit";
    const entries: TallyLedgerEntry[] = [
      {
        ledger: String(f.narration ?? "Bank entry"),
        amount,
        direction: direction === "credit" ? "debit" : "credit",
      },
      { ledger: String(f.account_reference ?? "Bank"), amount, direction },
    ];
    return {
      voucherType: Number(f.debit ?? 0) > 0 ? "Payment" : "Receipt",
      date: tallyDate(String(f.invoice_date ?? "")),
      narration: `[BAHI:${record.idempotencyKey}] ${f.narration ?? ""}`,
      party: String(f.narration ?? ""),
      company,
      entries,
      total: amount,
      gst: { cgst: 0, sgst: 0, igst: 0 },
      ...(reference ? { reference } : {}),
    };
  }

  if (record.docType === "purchase_order" || record.docType === "goods_receipt") {
    const inventory = inventoryAllocations(f);
    const lineTotal = inventory.reduce((sum, line) => sum + line.amount, 0);
    return {
      voucherType: record.docType === "purchase_order" ? "Purchase Order" : "Receipt Note",
      date: tallyDate(String(f.invoice_date ?? f.po_date ?? "")),
      narration: `[BAHI:${record.idempotencyKey}] ${f.vendor_name ?? ""} ${reference}`.trim(),
      party: String(f.vendor_name ?? "Sundry Creditors"),
      company,
      entries: [],
      inventory,
      total: total || lineTotal,
      gst: { cgst, sgst, igst },
      ...(reference ? { reference } : {}),
      ...(partyGstin ? { partyGstin } : {}),
    };
  }

  const creditNote = record.docType === "credit_note";
  const purchaseLedger =
    String(f.ledger ?? "").trim() ||
    `${creditNote ? "Purchase Return" : "Purchase"}${cgst + sgst + igst > 0 ? " @ 18%" : ""}`;
  const entries: TallyLedgerEntry[] = creditNote
    ? [
        { ledger: String(f.vendor_name ?? "Sundry Creditors"), amount: total, direction: "debit" },
        { ledger: purchaseLedger, amount: taxable, direction: "credit" },
      ]
    : [
        { ledger: purchaseLedger, amount: taxable, direction: "debit" },
        { ledger: String(f.vendor_name ?? "Sundry Creditors"), amount: total, direction: "credit" },
      ];

  const taxDirection: "debit" | "credit" = creditNote ? "credit" : "debit";
  if (cgst > 0) entries.push({ ledger: "Input CGST", amount: cgst, direction: taxDirection });
  if (sgst > 0) entries.push({ ledger: "Input SGST", amount: sgst, direction: taxDirection });
  if (igst > 0) entries.push({ ledger: "Input IGST", amount: igst, direction: taxDirection });
  if (roundOff !== 0) {
    entries.push({
      ledger: "Round Off",
      amount: Math.abs(roundOff),
      direction: creditNote
        ? roundOff > 0
          ? "credit"
          : "debit"
        : roundOff > 0
          ? "debit"
          : "credit",
    });
  }

  const tds = Math.max(0, Number(f.tds_amount ?? 0));
  if (tds > 0 && !creditNote) {
    const party = entries.find((entry) => entry.direction === "credit" && entry.amount === total);
    if (party) party.amount = Math.max(0, total - tds);
    entries.push({ ledger: "TDS Payable", amount: tds, direction: "credit" });
  }

  const notes = [
    f.vendor_name,
    reference,
    f.irn ? `IRN ${f.irn}` : "",
    f.eway_bill_number ? `EWB ${f.eway_bill_number}` : "",
    tds > 0 && f.tds_section ? `TDS ${f.tds_section}` : "",
    tds > 0 ? `TDS ₹${tds.toFixed(2)}` : "",
  ].filter(Boolean);

  return {
    voucherType: creditNote ? "Credit Note" : "Purchase",
    date: tallyDate(String(f.invoice_date ?? "")),
    narration: `[BAHI:${record.idempotencyKey}] ${notes.join(" ")}`.trim(),
    party: String(f.vendor_name ?? "Sundry Creditors"),
    company,
    entries,
    total,
    gst: { cgst, sgst, igst },
    ...(reference ? { reference } : {}),
    ...(partyGstin ? { partyGstin } : {}),
  };
}

export function tallyXml(payload: TallyVoucherPayload): string {
  const entries = payload.entries
    .map(
      (entry) => `
      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>${escapeXml(entry.ledger)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>${entry.direction === "debit" ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
        <AMOUNT>${(entry.direction === "debit" ? entry.amount : -entry.amount).toFixed(2)}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>`,
    )
    .join("");

  const inventory = (payload.inventory ?? [])
    .map(
      (line) => `
      <INVENTORYALLOCATIONS.LIST>
        <STOCKITEMNAME>${escapeXml(line.item)}</STOCKITEMNAME>
        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
        <RATE>${line.rate.toFixed(2)}</RATE>
        <AMOUNT>${line.amount.toFixed(2)}</AMOUNT>
        <ACTUALQTY>${line.quantity} ${escapeXml(line.unit ?? "Nos")}</ACTUALQTY>
        <BILLEDQTY>${line.quantity} ${escapeXml(line.unit ?? "Nos")}</BILLEDQTY>
        ${line.hsn ? `<HSNCODE>${escapeXml(line.hsn)}</HSNCODE>` : ""}
      </INVENTORYALLOCATIONS.LIST>`,
    )
    .join("");

  return `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${escapeXml(payload.company)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${escapeXml(payload.voucherType)}" ACTION="Create" OBJVIEW="Accounting Voucher View">
            ${payload.voucherNumber ? `<VOUCHERNUMBER>${escapeXml(payload.voucherNumber)}</VOUCHERNUMBER>` : ""}
            <DATE>${payload.date}</DATE>
            <NARRATION>${escapeXml(payload.narration)}</NARRATION>
            <VOUCHERTYPENAME>${escapeXml(payload.voucherType)}</VOUCHERTYPENAME>
            <PARTYLEDGERNAME>${escapeXml(payload.party)}</PARTYLEDGERNAME>
            ${payload.partyGstin ? `<PARTYGSTIN>${escapeXml(payload.partyGstin)}</PARTYGSTIN>` : ""}
            ${payload.reference ? `<REFERENCE>${escapeXml(payload.reference)}</REFERENCE>` : ""}
            ${payload.isOptional ? "<ISOPTIONAL>Yes</ISOPTIONAL>" : ""}
            <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>
${entries}${inventory}
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

export interface SheetRowValues {
  date: string;
  type: string;
  party: string;
  gstin: string;
  document: string;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  source: string;
  ledger: string;
  category: string;
  reference: string;
}

export const SHEET_HEADER_ROW = [
  "Date",
  "Document type",
  "Party",
  "GSTIN",
  "Document no.",
  "Taxable value",
  "CGST",
  "SGST",
  "IGST",
  "Total",
  "Source",
  "Ledger",
  "Category",
  "Reference",
] as const;

const SHEET_VALUE_ORDER: (keyof SheetRowValues)[] = [
  "date",
  "type",
  "party",
  "gstin",
  "document",
  "taxable",
  "cgst",
  "sgst",
  "igst",
  "total",
  "source",
  "ledger",
  "category",
  "reference",
];

function columnIndex(column: string): number | null {
  const value = column.trim().toUpperCase();
  if (/^\d+$/.test(value)) return Math.max(0, Number(value) - 1);
  if (!/^[A-Z]{1,2}$/.test(value)) return null;
  let index = 0;
  for (const char of value) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

/** Places values at the confirmed column letters, or in the default order. */
export function sheetRowArray(
  record: RecordRow,
  columns: SheetColumn[] | null,
): (string | number)[] {
  const values = sheetValues(record);
  if (!columns?.length) return SHEET_VALUE_ORDER.map((key) => values[key]);

  const width = Math.max(
    SHEET_VALUE_ORDER.length,
    ...columns.map((column) => (columnIndex(column.column) ?? 0) + 1),
  );
  const row = new Array<string | number>(width).fill("");
  for (const column of columns) {
    const index = columnIndex(column.column);
    if (index === null || index >= 1_000) continue;
    row[index] = column.field ? values[SHEET_FIELD_KEYS[column.field]!] : (column.fixedValue ?? "");
  }
  return row;
}

export function sheetValues(record: RecordRow): SheetRowValues {
  const f = record.fields;
  return {
    date: formatDate(String(f.invoice_date ?? record.createdAt)),
    type: record.docType.replace(/_/g, " "),
    party: String(f.vendor_name ?? f.narration ?? ""),
    gstin: String(f.vendor_gstin ?? ""),
    document: String(f.invoice_number ?? f.reference_number ?? ""),
    taxable: Number(f.taxable_value ?? f.debit ?? f.credit ?? 0),
    cgst: Number(f.cgst ?? 0),
    sgst: Number(f.sgst ?? 0),
    igst: Number(f.igst ?? 0),
    total: Number(f.total ?? 0),
    source: record.document?.filename ?? "Chat upload",
    ledger: String(f.ledger ?? ""),
    category: String(f.category ?? ""),
    reference: String(f.reference_number ?? ""),
  };
}

export interface PostResult {
  status: "posted" | "written";
  externalRef: string;
  note: string;
  payload: Record<string, unknown>;
}

const SHEET_FIELD_KEYS: Record<string, keyof SheetRowValues> = {
  invoice_date: "date",
  doc_type: "type",
  party: "party",
  vendor_name: "party",
  narration: "party",
  vendor_gstin: "gstin",
  invoice_number: "document",
  reference_number: "reference",
  taxable_value: "taxable",
  cgst: "cgst",
  sgst: "sgst",
  igst: "igst",
  total: "total",
  source: "source",
  ledger: "ledger",
  category: "category",
};

interface SheetColumn {
  column: string;
  field: string | null;
  fixedValue: string | null;
}

/** The destination mapper stores a confirmed column layout per sheet connection. */
export async function confirmedSheetColumns(
  schema: string,
  connectionId: string,
): Promise<SheetColumn[] | null> {
  const row = await sqlOne<{ mapping: unknown }>(
    `select mapping from ${table(schema, "mappings")}
      where kind = 'sheet_columns' and scope_key = $1 and status = 'confirmed'
      limit 1`,
    [connectionId],
  );
  const columns = (row?.mapping as { columns?: unknown } | undefined)?.columns;
  if (!Array.isArray(columns)) return null;
  const parsed = columns
    .map((entry) => {
      const item = entry as { column?: unknown; field?: unknown; fixedValue?: unknown };
      if (typeof item.column !== "string" || !item.column.trim()) return null;
      return {
        column: item.column.trim(),
        field: typeof item.field === "string" && item.field in SHEET_FIELD_KEYS ? item.field : null,
        fixedValue: typeof item.fixedValue === "string" ? item.fixedValue : null,
      };
    })
    .filter((entry): entry is SheetColumn => entry !== null);
  return parsed.length ? parsed : null;
}

export async function postTally(
  schema: string,
  record: RecordRow,
  company: string,
): Promise<PostResult> {
  const payload = buildTallyVoucher(record, company);
  const voucherNumber = `BAHI/${payload.date.slice(0, 6)}/${record.idempotencyKey.slice(-6).toUpperCase()}`;
  payload.voucherNumber = voucherNumber;
  const xml = tallyXml(payload);
  const totalDebit = payload.entries
    .filter((e) => e.direction === "debit")
    .reduce((s, e) => s + e.amount, 0);
  const totalCredit = payload.entries
    .filter((e) => e.direction === "credit")
    .reduce((s, e) => s + e.amount, 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(
      `Voucher does not balance: debits ${formatAmount(totalDebit)}, credits ${formatAmount(totalCredit)}.`,
    );
  }

  return {
    status: "posted",
    externalRef: voucherNumber,
    note: "Posted through the Tally bridge agent (demo connection).",
    payload: { ...payload, xml } as unknown as Record<string, unknown>,
  };
}

export async function writeSheet(schema: string, record: RecordRow): Promise<PostResult> {
  const connection = await sqlOne<{ id: string; spreadsheet_id: string | null }>(
    `select id, spreadsheet_id from ${table(schema, "sheet_connections")}
      where provider = 'google_sheets' and status = 'connected' order by created_at asc limit 1`,
  );
  if (!connection) {
    throw new Error("No Google Sheet is connected. Connect Google Sheets in Settings first.");
  }
  if (!connection.spreadsheet_id) {
    throw new Error("Choose the spreadsheet and tab in Settings before writing.");
  }

  const existing = await sqlOne<{ row_number: number }>(
    `select row_number from ${table(schema, "sheet_rows")}
      where connection_id = $1 and record_id = $2`,
    [connection.id, record.id],
  );
  if (existing) {
    return {
      status: "written",
      externalRef: `row ${existing.row_number}`,
      note: "This record is already in the sheet.",
      payload: sheetValues(record) as unknown as Record<string, unknown>,
    };
  }

  const columns = await confirmedSheetColumns(schema, connection.id);
  const values = sheetRowArray(record, columns);
  const { appendSheetRow } = await import("./google.server");
  const appended = await appendSheetRow(schema, values);
  await sql(
    `insert into ${table(schema, "sheet_rows")} (connection_id, record_id, row_number, values)
     values ($1, $2, $3, $4::jsonb)
     on conflict (connection_id, record_id) do nothing`,
    [
      connection.id,
      record.id,
      appended.rowNumber,
      JSON.stringify(columns ? values : sheetValues(record)),
    ],
  );
  return {
    status: "written",
    externalRef: appended.updatedRange || `row ${appended.rowNumber}`,
    note: "Appended to Google Sheets.",
    payload: sheetValues(record) as unknown as Record<string, unknown>,
  };
}

export async function buildExcelBase64(records: RecordRow[]): Promise<string> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Bahi";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("Entries", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = [
    { header: "Date", key: "date", width: 14 },
    { header: "Document type", key: "type", width: 20 },
    { header: "Vendor / narration", key: "party", width: 30 },
    { header: "GSTIN", key: "gstin", width: 20 },
    { header: "Document no.", key: "document", width: 22 },
    { header: "Taxable value", key: "taxable", width: 15 },
    { header: "CGST", key: "cgst", width: 12 },
    { header: "SGST", key: "sgst", width: 12 },
    { header: "IGST", key: "igst", width: 12 },
    { header: "Total", key: "total", width: 15 },
    { header: "Source", key: "source", width: 30 },
  ];

  for (const record of records) {
    const values = sheetValues(record);
    sheet.addRow({
      date: values.date,
      type: values.type,
      party: values.party,
      gstin: values.gstin,
      document: values.document,
      taxable: values.taxable,
      cgst: values.cgst,
      sgst: values.sgst,
      igst: values.igst,
      total: values.total,
      source: values.source,
    });
  }

  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F0EA" } };
  sheet.getColumn("taxable").numFmt = "#,##0.00";
  sheet.getColumn("cgst").numFmt = "#,##0.00";
  sheet.getColumn("sgst").numFmt = "#,##0.00";
  sheet.getColumn("igst").numFmt = "#,##0.00";
  sheet.getColumn("total").numFmt = "#,##0.00";

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer).toString("base64");
}

export async function markExcelWritten(schema: string, record: RecordRow): Promise<PostResult> {
  const values = sheetValues(record);
  return {
    status: "written",
    externalRef: `Excel row for ${String(record.fields.invoice_number ?? record.title)}`,
    note: "Workbook is ready to download from the record.",
    payload: values as unknown as Record<string, unknown>,
  };
}

export async function postRecordToDestination(
  schema: string,
  record: RecordRow,
  destination: Destination,
  company: string,
): Promise<PostResult> {
  if (destination === "tally") return postTally(schema, record, company);
  if (destination === "google_sheets") return writeSheet(schema, record);
  return markExcelWritten(schema, record);
}

export function describeDestinationPayload(
  record: RecordRow,
  company: string,
): TallyVoucherPayload | SheetRowValues {
  if (record.destination === "tally") return buildTallyVoucher(record, company);
  return sheetValues(record);
}

export function fieldEntries(fields: FieldMap): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const labels: Record<string, string> = {
    vendor_name: "Vendor",
    vendor_gstin: "GSTIN",
    invoice_number: "Document no.",
    invoice_date: "Date",
    place_of_supply: "Place of supply",
    taxable_value: "Taxable value",
    cgst: "CGST",
    sgst: "SGST",
    igst: "IGST",
    round_off: "Round off",
    total: "Total",
    narration: "Narration",
    reference_number: "Reference",
    debit: "Debit",
    credit: "Credit",
    balance: "Balance",
  };
  for (const [key, label] of Object.entries(labels)) {
    const value = fields[key];
    if (value === undefined || value === null || value === "") continue;
    const isMoney = [
      "taxable_value",
      "cgst",
      "sgst",
      "igst",
      "round_off",
      "total",
      "debit",
      "credit",
      "balance",
    ].includes(key);
    rows.push({
      label,
      value: isMoney
        ? `₹${formatAmount(Number(value))}`
        : key === "invoice_date"
          ? formatDate(String(value))
          : String(value),
    });
  }
  return rows;
}
