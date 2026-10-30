import type { DocType, FieldMap, LineItem } from "@/lib/types";

export interface ExtractionResult {
  docType: DocType;
  fields: FieldMap;
  confidences: Record<string, number>;
  title: string;
  vendorStatus?: FieldMap["vendor_status"];
  locations?: Record<string, { page?: number | undefined; hint?: string | undefined }>;
}

export interface SampleDocument {
  id: string;
  label: string;
  description: string;
  filename: string;
  mimeType: string;
  expectedType: DocType;
  text: string;
  confidenceOverrides?: Record<string, number>;
  vendorStatus?: FieldMap["vendor_status"];
}

const CLEAN_INVOICE = `TAX INVOICE
Deccan Steel Traders
GSTIN: 27AACCP9876D1Z1
Address: Plot 14, MIDC Bhosari, Pune 411026
Invoice No: DST/26-27/0412
Invoice Date: 20/10/2026
Place of Supply: 27 - Maharashtra
Buyer: Shree Metals Works, Pune
Buyer GSTIN: 27AABCS1234F1ZR

Description | HSN | Qty | Unit | Rate | Amount | GST %
1 | MS Seamless Pipe 2 inch SCH 40 | HSN 7306 | 250 | KG | 148.00 | 37000.00 | 18
2 | MS Square Pipe 40x40 | HSN 7306 | 600 | KG | 135.00 | 81000.00 | 18

Taxable Value: 118000.00
CGST @ 9%: 10620.00
SGST @ 9%: 10620.00
IGST: 0.00
Round Off: 0.00
Total: 139240.00
Amount in words: One lakh thirty nine thousand two hundred forty only
`;

const PROBLEM_INVOICE = `TAX INVOICE
Apex Polymers Pvt Ltd
GSTIN: 29AAGCA5678K1Z1
Address: Peenya Industrial Area, Bengaluru 560058
Invoice No: APX/2026/1187
Invoice Date: 18/10/2026
Place of Supply: 27 - Maharashtra
Buyer: Shree Metals Works, Pune
Buyer GSTIN: 27AABCS1234F1ZR

Description | HSN | Qty | Unit | Rate | Amount | GST %
1 | HDPE Granules Grade 50 | HSN 3917 | 1200 | KG | 96.00 | 115200.00 | 18

Taxable Value: 115200.00
CGST @ 9%: 10368.00
SGST @ 9%: 10368.00
IGST: 0.00
Round Off: 0.00
Total: 135948.00
`;

const LOW_CONFIDENCE_INVOICE = `TAX INVOICE
Kirti Engineering Works
GSTIN: 27AAFCK2468M1Z2
Address: Unit 6, GIDC Vatva, Ahmedabad 382445
Invoice No: KEW/2026/076
Invoice Date: 22/10/2026
Place of Supply: 27 - Maharashtra
Buyer: Shree Metals Works, Pune
Buyer GSTIN: 27AABCS1234F1ZR

Description | HSN | Qty | Unit | Rate | Amount | GST %
1 | CI Pipe Fittings assorted | HSN 8481 | 320 | KG | 150.00 | 48000.00 | 18

Taxable Value: 48000.00
CGST @ 9%: 4320.00
SGST @ 9%: 4320.00
IGST: 0.00
Round Off: 0.00
Total: 56640.00
`;

const BANK_STATEMENT = `HDFC BANK
Statement of Account
Account: Shree Metals Works - Current A/c 7890
Period: 01/10/2026 to 25/10/2026

Date | Narration | Reference | Debit | Credit | Balance
20/10/2026 | NEFT TO BHARAT FASTENERS | NEFT/2026/88121 | 23600.00 | | 481250.00
22/10/2026 | UPI TO DECCAN STEEL TRADERS | UPI/998211/APEX | 45000.00 | | 436250.00
24/10/2026 | BANK CHARGES OCTOBER | CHG/1026/778 | 118.00 | | 436132.00
`;

export const SAMPLE_DOCUMENTS: SampleDocument[] = [
  {
    id: "clean-invoice",
    label: "Clean supplier invoice",
    description: "Deccan Steel Traders · ₹1,39,240 · passes every GST check",
    filename: "deccan-steel-DST-0412.pdf",
    mimeType: "text/plain",
    expectedType: "supplier_invoice",
    text: CLEAN_INVOICE,
    vendorStatus: "active",
    confidenceOverrides: { line_items: 0.97, invoice_date: 0.98 },
  },
  {
    id: "problem-invoice",
    label: "Invoice with problems",
    description: "Apex Polymers · cancelled GSTIN, wrong tax split, ₹12 total mismatch",
    filename: "apex-polymers-APX-1187.pdf",
    mimeType: "text/plain",
    expectedType: "supplier_invoice",
    text: PROBLEM_INVOICE,
    confidenceOverrides: { vendor_gstin: 0.74, total: 0.62 },
    vendorStatus: "cancelled",
  },
  {
    id: "low-confidence-invoice",
    label: "Smudged / low-confidence invoice",
    description: "Kirti Engineering · readable but below the confidence threshold",
    filename: "kirti-engineering-KEW-076.pdf",
    mimeType: "text/plain",
    expectedType: "supplier_invoice",
    text: LOW_CONFIDENCE_INVOICE,
    confidenceOverrides: {
      line_items: 0.86,
      total: 0.88,
      vendor_name: 0.91,
      invoice_number: 0.93,
    },
  },
  {
    id: "bank-statement",
    label: "Bank statement",
    description: "HDFC current account · 3 lines ready for sheets",
    filename: "hdfc-current-oct-2026.csv",
    mimeType: "text/csv",
    expectedType: "bank_statement",
    text: BANK_STATEMENT,
  },
];

const GSTIN_PATTERN = /\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z])\b/;

function parseAmount(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[₹,\s]/g, "");
  const number = Number.parseFloat(cleaned);
  return Number.isFinite(number) ? number : undefined;
}

/** Reads the last amount on the line that carries the label, so "CGST @ 9%: 10,620.00" yields 10620. */
function findMoney(text: string, labels: string[]): number | undefined {
  for (const label of labels) {
    const line = text
      .split(/\r?\n/)
      .find((candidate) => new RegExp(`^\\s*(?:.*?\\s)?${label}\\b`, "i").test(candidate));
    if (!line) continue;
    const amounts = [...line.matchAll(/(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?/g)].map(
      (m) => m[0],
    );
    const last = amounts.at(-1);
    if (last) {
      const parsed = parseAmount(last);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

export function parseDate(value: string): string | undefined {
  const trimmed = value.trim();
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slash = trimmed.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (slash) {
    const day = slash[1]!.padStart(2, "0");
    const month = slash[2]!.padStart(2, "0");
    let year = slash[3]!;
    if (year.length === 2) year = `20${year}`;
    if (Number(month) > 12 || Number(day) > 31) return undefined;
    return `${year}-${month}-${day}`;
  }
  const monthName = trimmed.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (monthName) {
    const months = [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ];
    const index = months.indexOf(monthName[2]!.slice(0, 3).toLowerCase());
    if (index >= 0)
      return `${monthName[3]}-${String(index + 1).padStart(2, "0")}-${monthName[1]!.padStart(2, "0")}`;
  }
  return undefined;
}

export function classifyDocument(text: string): DocType | null {
  const lower = text.toLowerCase();
  if (/(statement of account|bank statement|account statement)/.test(lower))
    return "bank_statement";
  if (/e-?way bill/.test(lower)) return "e_way_bill";
  if (/e-?invoice|irn\s*:/.test(lower)) return "e_invoice";
  if (/purchase order|\bpo no\b/.test(lower)) return "purchase_order";
  if (/delivery challan|goods receipt|receipt note/.test(lower)) return "goods_receipt";
  if (/credit note|credit memo/.test(lower)) return "credit_note";
  if (/tax invoice|invoice no|invoice number|bill no/.test(lower)) return "supplier_invoice";
  return null;
}

function matchLabel(text: string, labels: string[]): string | undefined {
  for (const label of labels) {
    const regex = new RegExp(`${label}\\s*[:\\-]?\\s*([^\\n\\r]+)`, "i");
    const match = text.match(regex);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function findVendorName(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const headerIndex = lines.findIndex((line) =>
    /tax invoice|invoice|statement of account/i.test(line),
  );
  const candidates = lines
    .slice(headerIndex >= 0 ? headerIndex + 1 : 0, (headerIndex >= 0 ? headerIndex : 0) + 6)
    .filter(
      (line) =>
        !/gstin|address|invoice|date|place of supply|buyer|account|statement|period|^[-|]+$/i.test(
          line,
        ) &&
        /[A-Za-z]/.test(line) &&
        line.length > 3 &&
        line.length < 80,
    );
  return candidates[0];
}

function parseLineItems(text: string): LineItem[] {
  const items: LineItem[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^\d+\s*[|.)]/.test(line)) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length >= 7) {
      const description = cells[1] ?? "";
      const hsnText = cells[2] ?? "";
      const hsn = hsnText.match(/(\d{4,8})/)?.[1];
      const quantity = parseAmount(cells[3]);
      const unit = cells[4];
      const rate = parseAmount(cells[5]);
      const amount = parseAmount(cells[6]);
      const taxRate = parseAmount(cells[7]);
      if (description && amount !== undefined) {
        items.push({
          description,
          ...(hsn ? { hsn } : {}),
          ...(quantity !== undefined ? { quantity } : {}),
          ...(unit ? { unit } : {}),
          ...(rate !== undefined ? { rate } : {}),
          amount,
          ...(taxRate !== undefined ? { tax_rate: taxRate } : {}),
        });
      }
    }
  }
  return items;
}

function parsePlaceOfSupply(text: string): string | undefined {
  const raw = matchLabel(text, ["Place of Supply", "Place Of Supply", "POS"]);
  if (!raw) return undefined;
  const code = raw.match(/\b(\d{2})\b/)?.[1];
  return code ? `${code} - ${raw.replace(/^\d{2}\s*[-–]?\s*/, "")}`.replace(/\s+$/, "") : raw;
}

function confidenceFor(
  overrides: Record<string, number> | undefined,
  field: string,
  base: number,
): number {
  return overrides?.[field] ?? base;
}

function invoiceTitle(fields: FieldMap): string {
  const vendor = fields.vendor_name || "Supplier invoice";
  return fields.invoice_number ? `${vendor} · ${fields.invoice_number}` : vendor;
}

function extractInvoice(text: string, overrides?: Record<string, number>): ExtractionResult {
  const gstin = text.match(GSTIN_PATTERN)?.[1];
  const lineItems = parseLineItems(text);
  const dateRaw = matchLabel(text, ["Invoice Date", "Bill Date", "Date"]);
  const invoiceDate = dateRaw ? parseDate(dateRaw) : undefined;
  const invoiceNumber = matchLabel(text, [
    "Invoice No",
    "Invoice Number",
    "Bill No",
    "Invoice #",
  ])?.replace(/\s{2,}.*$/, "");
  const taxable = findMoney(text, ["Taxable Value", "Taxable Amount"]);
  const cgst = findMoney(text, ["CGST"]);
  const sgst = findMoney(text, ["SGST"]);
  const igst = findMoney(text, ["IGST"]);
  const roundOff = findMoney(text, ["Round Off", "Round-off", "Rounding"]) ?? 0;
  const total = findMoney(text, ["Invoice Total", "Grand Total", "Total"]);
  const irn = text.match(/IRN\s*[:-]?\s*([a-f0-9]{64})/i)?.[1];
  const eway = text.match(/E-?Way Bill(?:\s*No)?\s*[:-]?\s*(\d{10,14})/i)?.[1];
  const po = matchLabel(text, ["PO No", "Purchase Order No", "PO Number"]);
  const vendorName = findVendorName(text);

  const fields: FieldMap = {
    vendor_name: vendorName,
    vendor_gstin: gstin?.toUpperCase(),
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate,
    place_of_supply: parsePlaceOfSupply(text),
    line_items: lineItems,
    taxable_value: taxable,
    cgst: cgst ?? 0,
    sgst: sgst ?? 0,
    igst: igst ?? 0,
    round_off: roundOff,
    total,
    vendor_category: "goods",
    ...(irn ? { irn } : {}),
    ...(eway ? { eway_bill_number: eway } : {}),
    ...(po ? { po_number: po } : {}),
  };

  const confidences: Record<string, number> = {
    vendor_name: confidenceFor(overrides, "vendor_name", 0.94),
    vendor_gstin: confidenceFor(overrides, "vendor_gstin", gstin ? 0.99 : 0.2),
    invoice_number: confidenceFor(overrides, "invoice_number", invoiceNumber ? 0.97 : 0.2),
    invoice_date: confidenceFor(overrides, "invoice_date", invoiceDate ? 0.96 : 0.2),
    line_items: confidenceFor(overrides, "line_items", lineItems.length ? 0.92 : 0.3),
    taxable_value: confidenceFor(overrides, "taxable_value", taxable ? 0.97 : 0.2),
    total: confidenceFor(overrides, "total", total ? 0.98 : 0.2),
  };

  return {
    docType: "supplier_invoice",
    fields,
    confidences,
    title: invoiceTitle(fields),
  };
}

function extractBankLines(text: string): ExtractionResult[] {
  const results: ExtractionResult[] = [];
  const account = text.match(/Account:\s*([^\n]+)/i)?.[1]?.trim();

  for (const rawLine of text.split(/\r?\n/)) {
    const cells = rawLine.split("|").map((cell) => cell.trim());
    if (cells.length < 6) continue;
    const date = parseDate(cells[0] ?? "");
    if (!date) continue;
    const narration = cells[1] ?? "";
    const reference = cells[2] ?? "";
    const debit = parseAmount(cells[3]);
    const credit = parseAmount(cells[4]);
    const balance = parseAmount(cells[5]);
    const amount = debit ?? credit ?? 0;

    const fields: FieldMap = {
      account_reference: account,
      invoice_date: date,
      narration,
      reference_number: reference,
      debit: debit ?? 0,
      credit: credit ?? 0,
      balance,
      total: amount,
    };
    results.push({
      docType: "bank_statement",
      fields,
      confidences: {
        invoice_date: 0.98,
        narration: 0.96,
        debit: debit !== undefined ? 0.98 : 0.99,
        credit: credit !== undefined ? 0.98 : 0.99,
        total: 0.97,
      },
      title: `${debit ? "Payment" : "Receipt"} · ${narration.slice(0, 42)}`,
    });
  }

  return results;
}

export interface ExtractionInput {
  text: string;
  filename?: string | undefined;
  overrides?: Record<string, number> | undefined;
  vendorStatus?: FieldMap["vendor_status"] | undefined;
}

/**
 * Deterministic extractor used when no vision model is configured. It reads
 * the text layer of a PDF, pasted invoice text or a bank statement export and
 * returns pack-shaped fields plus a confidence per field.
 */
export function extractFromText(input: ExtractionInput): ExtractionResult[] {
  const text = input.text.split("\u0000").join("").trim();
  if (!text) return [];
  const docType = classifyDocument(text);

  if (docType === "bank_statement") {
    return extractBankLines(text).map((result) => ({
      ...result,
      ...(input.vendorStatus ? { vendorStatus: input.vendorStatus } : {}),
    }));
  }

  if (docType === "supplier_invoice" || docType === "credit_note" || docType === null) {
    const result = extractInvoice(text, input.overrides);
    if (docType === "credit_note") {
      result.docType = "credit_note";
      result.title = `Credit note · ${String(result.fields.invoice_number ?? "unread")}`;
    }
    if (input.vendorStatus) result.vendorStatus = input.vendorStatus;
    if (!result.fields.vendor_gstin && !result.fields.invoice_number && !result.fields.total) {
      return [];
    }
    return [result];
  }

  if (docType === "e_way_bill" || docType === "e_invoice") {
    const gstin = text.match(GSTIN_PATTERN)?.[1];
    const total = parseAmount(matchLabel(text, ["Value", "Total", "Invoice Value"]));
    const number =
      text.match(/E-?Way Bill(?:\s*No)?\s*[:-]?\s*(\d{10,14})/i)?.[1] ??
      text.match(/IRN\s*[:-]?\s*([a-f0-9]{64})/i)?.[1];
    const fields: FieldMap = {
      vendor_gstin: gstin?.toUpperCase(),
      invoice_number: matchLabel(text, ["Invoice No", "Document No"]),
      invoice_date: parseDate(matchLabel(text, ["Date", "Generation Date"]) ?? ""),
      total,
      ...(docType === "e_way_bill" ? { eway_bill_number: number } : { irn: number }),
    };
    return [
      {
        docType,
        fields,
        confidences: { vendor_gstin: 0.95, invoice_number: 0.9, invoice_date: 0.9, total: 0.93 },
        title: `${docType === "e_way_bill" ? "E-way bill" : "E-invoice"} · ${number ?? "unread"}`,
      },
    ];
  }

  if (docType === "purchase_order" || docType === "goods_receipt") {
    const fields: FieldMap = {
      po_number: matchLabel(text, ["PO No", "Purchase Order No"]),
      challan_number: matchLabel(text, ["Challan No", "Delivery Challan No"]),
      vendor_name: findVendorName(text),
      vendor_gstin: text.match(GSTIN_PATTERN)?.[1]?.toUpperCase(),
      invoice_date: parseDate(matchLabel(text, ["Date", "PO Date", "Challan Date"]) ?? ""),
      line_items: parseLineItems(text),
    };
    return [
      {
        docType,
        fields,
        confidences: {
          po_number: 0.9,
          challan_number: 0.9,
          vendor_name: 0.9,
          invoice_date: 0.9,
          line_items: 0.85,
        },
        title: fields.po_number ?? fields.challan_number ?? "Matching document",
      },
    ];
  }

  return [];
}

export function getSampleDocument(id: string): SampleDocument | undefined {
  return SAMPLE_DOCUMENTS.find((sample) => sample.id === id);
}
