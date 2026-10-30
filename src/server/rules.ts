import type { DocType, FieldMap, RuleResult, TenantSettings } from "@/lib/types";
import type { Gstr2bEvidence, ThreeWayEvidence } from "./matching.server";

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const STATE_CODES: Record<string, string> = {
  "01": "Jammu & Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "26": "Dadra & Nagar Haveli and Daman & Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman & Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
};

export function gstinChecksum(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_CHARS.indexOf(first14[i] ?? "");
    if (value < 0) return "";
    const factor = i % 2 === 0 ? 1 : 2;
    const product = value * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36] ?? "";
}

export function isValidGstin(value: string): boolean {
  const gstin = value.trim().toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(gstin)) return false;
  if (!STATE_CODES[gstin.slice(0, 2)]) return false;
  return gstinChecksum(gstin.slice(0, 14)) === gstin[14];
}

export function gstinState(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const code = value.trim().slice(0, 2);
  return STATE_CODES[code] ? code : undefined;
}

function stateFromPlaceOfSupply(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/\b(\d{2})\b/);
  return match?.[1];
}

const toMinor = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : 0;

const money = (minor: number): string =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(minor / 100);

export interface ExistingRecordKey {
  id: string;
  vendorGstin?: string | null;
  invoiceNumber?: string | null;
  amountMinor?: number | null;
  title?: string | null;
}

export interface RuleInput {
  docType: DocType;
  fields: FieldMap;
  confidences: Record<string, number>;
  settings: TenantSettings;
  existing?: ExistingRecordKey[];
  today?: Date;
  match?: {
    threeWay?: ThreeWayEvidence;
    gstr2b?: Gstr2bEvidence;
  };
}

const MANDATORY_FIELDS: Record<DocType, string[]> = {
  supplier_invoice: ["vendor_gstin", "invoice_number", "invoice_date", "line_items", "total"],
  credit_note: ["vendor_gstin", "invoice_number", "invoice_date", "line_items", "total"],
  purchase_order: ["po_number", "vendor_name", "line_items"],
  goods_receipt: ["challan_number", "line_items"],
  e_way_bill: ["eway_bill_number", "vendor_gstin", "invoice_number", "total"],
  e_invoice: ["irn", "vendor_gstin", "invoice_number", "total"],
  bank_statement: ["invoice_date", "narration"],
};

function fieldLabel(field: string): string {
  return field
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace("Gstin", "GSTIN")
    .replace("Hsn", "HSN");
}

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function mandatoryFields(docType: DocType): string[] {
  return MANDATORY_FIELDS[docType] ?? [];
}

export function overallConfidence(
  docType: DocType,
  fields: FieldMap,
  confidences: Record<string, number>,
): number {
  const required = MANDATORY_FIELDS[docType] ?? [];
  if (!required.length) return 0;
  let min = 1;
  for (const field of required) {
    if (isBlank(fields[field])) return 0;
    const confidence = confidences[field] ?? 0;
    min = Math.min(min, confidence);
  }
  return Math.round(min * 1000) / 1000;
}

function pass(id: string, label: string, message: string): RuleResult {
  return { id, label, outcome: "pass", message };
}

function warn(id: string, label: string, message: string): RuleResult {
  return { id, label, outcome: "warn", message };
}

function fail(id: string, label: string, message: string): RuleResult {
  return { id, label, outcome: "fail", message };
}

function skip(id: string, label: string, message: string): RuleResult {
  return { id, label, outcome: "skipped", message };
}

function mandatoryRule(fields: FieldMap, docType: DocType): RuleResult {
  const required = MANDATORY_FIELDS[docType] ?? [];
  const missing = required.filter((field) => isBlank(fields[field]));
  if (missing.length) {
    return fail(
      "mandatory_fields",
      "Mandatory fields",
      `Missing ${missing.map(fieldLabel).join(", ")}. These are required before posting.`,
    );
  }
  return pass("mandatory_fields", "Mandatory fields", "All mandatory fields are present.");
}

function gstinFormatRule(fields: FieldMap): RuleResult {
  const gstin = String(fields.vendor_gstin ?? "")
    .trim()
    .toUpperCase();
  if (!gstin) return fail("gstin_format", "GSTIN format", "Supplier GSTIN is missing.");
  if (!isValidGstin(gstin)) {
    return fail(
      "gstin_format",
      "GSTIN format",
      `Supplier GSTIN ${gstin} is not valid. Check the state code, PAN and checksum character.`,
    );
  }
  return pass("gstin_format", "GSTIN format", `GSTIN ${gstin} is correctly formed.`);
}

function gstinStatusRule(fields: FieldMap): RuleResult {
  const status = fields.vendor_status;
  if (status === "cancelled") {
    return fail(
      "gstin_status",
      "GSTIN active status",
      "The supplier GSTIN is cancelled. Input credit is at risk.",
    );
  }
  if (status === "suspended") {
    return fail("gstin_status", "GSTIN active status", "The supplier GSTIN is suspended.");
  }
  if (status === "active") {
    return pass("gstin_status", "GSTIN active status", "GSTN shows the supplier GSTIN as active.");
  }
  return warn(
    "gstin_status",
    "GSTIN active status",
    "GSTN lookup is not connected, so active status is unverified. It will be rechecked before posting.",
  );
}

function placeOfSupplyRule(fields: FieldMap): RuleResult {
  const vendorState =
    gstinState(String(fields.vendor_gstin ?? "")) ?? String(fields.vendor_state ?? "").slice(0, 2);
  const place = stateFromPlaceOfSupply(String(fields.place_of_supply ?? "")) ?? vendorState;
  if (!vendorState || !place) {
    return warn(
      "place_of_supply",
      "Tax type vs place of supply",
      "Place of supply could not be determined.",
    );
  }

  const cgst = toMinor(fields.cgst);
  const sgst = toMinor(fields.sgst);
  const igst = toMinor(fields.igst);
  const intra = vendorState === place;

  if (intra && cgst + sgst > 0 && igst === 0) {
    return pass(
      "place_of_supply",
      "Tax type vs place of supply",
      "CGST and SGST applied for an intra-state supply.",
    );
  }
  if (!intra && igst > 0 && cgst === 0 && sgst === 0) {
    return pass(
      "place_of_supply",
      "Tax type vs place of supply",
      "IGST applied for an inter-state supply.",
    );
  }
  return fail(
    "place_of_supply",
    "Tax type vs place of supply",
    intra
      ? "This is an intra-state supply, so it should carry CGST and SGST, not IGST."
      : `Supplier state ${vendorState} differs from place of supply ${place}, so IGST should apply.`,
  );
}

function taxArithmeticRule(fields: FieldMap, settings: TenantSettings): RuleResult {
  const taxable = toMinor(fields.taxable_value);
  const tax = toMinor(fields.cgst) + toMinor(fields.sgst) + toMinor(fields.igst);
  if (!taxable) return skip("tax_arithmetic", "Tax arithmetic", "Taxable value is not available.");

  const lines = Array.isArray(fields.line_items) ? fields.line_items : [];
  const rated = lines.filter(
    (line) => typeof line.tax_rate === "number" && typeof line.amount === "number",
  );
  if (rated.length) {
    const expected = rated.reduce(
      (sum, line) => sum + Math.round(toMinor(line.amount) * (line.tax_rate! / 100)),
      0,
    );
    const difference = Math.abs(expected - tax);
    if (difference <= settings.gst.toleranceMinor) {
      return pass(
        "tax_arithmetic",
        "Tax arithmetic",
        "Line-level tax matches the taxable value and rates.",
      );
    }
    return fail(
      "tax_arithmetic",
      "Tax arithmetic",
      `Tax on the invoice is ${money(tax)}, but the line rates give ${money(expected)}.`,
    );
  }

  if (!tax)
    return fail("tax_arithmetic", "Tax arithmetic", "No GST has been captured on the invoice.");
  const effective = (tax / taxable) * 100;
  const standard = [0, 5, 12, 18, 28].some((rate) => Math.abs(rate - effective) < 0.15);
  return standard
    ? pass("tax_arithmetic", "Tax arithmetic", `Effective GST rate is ${effective.toFixed(2)}%.`)
    : warn(
        "tax_arithmetic",
        "Tax arithmetic",
        `Effective GST rate works out to ${effective.toFixed(2)}%, which is not a standard slab.`,
      );
}

function lineTotalRule(fields: FieldMap, settings: TenantSettings): RuleResult {
  const lines = Array.isArray(fields.line_items) ? fields.line_items : [];
  if (!lines.length) return skip("line_totals", "Line totals", "No line items to check.");
  const sum = lines.reduce((total, line) => total + toMinor(line.amount), 0);
  const taxable = toMinor(fields.taxable_value);
  if (!taxable) return skip("line_totals", "Line totals", "Taxable value is not available.");
  const difference = Math.abs(sum - taxable);
  if (difference === 0)
    return pass("line_totals", "Line totals", "Line amounts add up to the taxable value.");
  if (difference <= settings.gst.toleranceMinor) {
    return warn(
      "line_totals",
      "Line totals",
      `Line amounts differ from taxable value by ${money(difference)}.`,
    );
  }
  return fail(
    "line_totals",
    "Line totals",
    `Line amounts total ${money(sum)}, but the taxable value is ${money(taxable)}.`,
  );
}

function totalArithmeticRule(fields: FieldMap, settings: TenantSettings): RuleResult {
  if (fields.total === undefined)
    return fail("total_arithmetic", "Total arithmetic", "Invoice total is missing.");
  const expected =
    toMinor(fields.taxable_value) +
    toMinor(fields.cgst) +
    toMinor(fields.sgst) +
    toMinor(fields.igst) +
    toMinor(fields.round_off);
  const actual = toMinor(fields.total);
  const difference = Math.abs(expected - actual);
  if (difference === 0) {
    return pass(
      "total_arithmetic",
      "Total arithmetic",
      "Taxable value, GST and round-off add up to the total.",
    );
  }
  if (difference <= settings.gst.toleranceMinor) {
    return warn(
      "total_arithmetic",
      "Total arithmetic",
      `Invoice total differs from taxable value plus tax by ${money(difference)}.`,
    );
  }
  return fail(
    "total_arithmetic",
    "Total arithmetic",
    `Invoice total is ${money(actual)}, but taxable value plus tax is ${money(expected)}.`,
  );
}

function hsnRule(fields: FieldMap, settings: TenantSettings): RuleResult {
  const lines = Array.isArray(fields.line_items) ? fields.line_items : [];
  if (!lines.length) return skip("hsn_rate", "HSN and rate check", "No line items to check.");
  const problems: string[] = [];
  for (const line of lines) {
    const hsn = String(line.hsn ?? "").trim();
    if (!/^\d{4,8}$/.test(hsn)) {
      problems.push(`HSN "${hsn || "missing"}" is not 4–8 digits`);
      continue;
    }
    const expected = settings.gst.knownHsnRates[hsn];
    if (expected === undefined) {
      problems.push(`HSN ${hsn} is not in the pack rate list`);
    } else if (typeof line.tax_rate === "number" && Math.abs(expected - line.tax_rate) > 0.01) {
      problems.push(`HSN ${hsn} usually carries ${expected}% GST, not ${line.tax_rate}%`);
    }
  }
  if (!problems.length)
    return pass("hsn_rate", "HSN and rate check", "HSN codes and rates match the pack.");
  return warn("hsn_rate", "HSN and rate check", `${problems.join("; ")}.`);
}

function duplicateRule(
  fields: FieldMap,
  existing: ExistingRecordKey[],
  totalMinor: number,
): RuleResult {
  const gstin = String(fields.vendor_gstin ?? "")
    .trim()
    .toUpperCase();
  const number = String(fields.invoice_number ?? "")
    .trim()
    .toLowerCase();
  if (!number)
    return skip("duplicate_invoice", "Duplicate invoice", "No invoice number to compare.");

  const exact = existing.find(
    (record) =>
      String(record.vendorGstin ?? "")
        .trim()
        .toUpperCase() === gstin &&
      String(record.invoiceNumber ?? "")
        .trim()
        .toLowerCase() === number,
  );
  if (exact) {
    return fail(
      "duplicate_invoice",
      "Duplicate invoice",
      `Invoice ${fields.invoice_number} from this supplier already exists (${exact.title ?? "earlier record"}).`,
    );
  }

  const near = existing.find(
    (record) =>
      String(record.vendorGstin ?? "")
        .trim()
        .toUpperCase() === gstin &&
      typeof record.amountMinor === "number" &&
      Math.abs(record.amountMinor - totalMinor) <= 100,
  );
  if (near) {
    return warn(
      "duplicate_invoice",
      "Duplicate invoice",
      `A record from the same supplier has almost the same value (${near.title ?? "earlier record"}). Check for a duplicate.`,
    );
  }
  return pass("duplicate_invoice", "Duplicate invoice", "No matching supplier invoice found.");
}

function threeWayMatchRule(fields: FieldMap, evidence?: ThreeWayEvidence): RuleResult {
  if (!evidence) {
    if (!fields.po_number) {
      return skip(
        "three_way_match",
        "Three-way match",
        "No purchase order is linked to this invoice.",
      );
    }
    return warn(
      "three_way_match",
      "Three-way match",
      `Purchase order ${fields.po_number} is not among the uploaded records yet.`,
    );
  }
  if (evidence.poMatched && evidence.grMatched) {
    return pass(
      "three_way_match",
      "Three-way match",
      "Invoice, purchase order and goods receipt agree.",
    );
  }
  if (evidence.poMatched) {
    return warn("three_way_match", "Three-way match", evidence.grReason);
  }
  if (evidence.poNumber) {
    return warn("three_way_match", "Three-way match", evidence.poReason);
  }
  return skip("three_way_match", "Three-way match", evidence.poReason);
}

function gstr2bRule(evidence?: Gstr2bEvidence): RuleResult {
  if (!evidence) {
    return skip(
      "gstr2b_match",
      "GSTR-2B match",
      "No imported GSTR-2B covers this invoice in this workspace.",
    );
  }
  if (evidence.status === "matched") {
    return pass(
      "gstr2b_match",
      "GSTR-2B match",
      `Matched in GSTR-2B${evidence.period ? ` for ${evidence.period}` : ""}.`,
    );
  }
  if (evidence.status === "mismatch") {
    return warn("gstr2b_match", "GSTR-2B match", evidence.reason);
  }
  return warn(
    "gstr2b_match",
    "GSTR-2B match",
    evidence.status === "not_in_2b"
      ? `This invoice is not in the imported GSTR-2B${evidence.period ? ` for ${evidence.period}` : ""}.`
      : evidence.reason,
  );
}

function eInvoiceRule(docType: DocType, fields: FieldMap, settings: TenantSettings): RuleResult {
  const total = toMinor(fields.total);
  const irn = String(fields.irn ?? "").trim();
  const required = docType === "e_invoice" || total >= settings.gst.eInvoiceThresholdMinor;
  if (!required) {
    return skip("e_invoice", "E-invoice IRN", "Invoice is below the e-invoicing threshold.");
  }
  if (!irn) {
    return fail(
      "e_invoice",
      "E-invoice IRN",
      "This invoice needs an IRN because it is above the e-invoicing threshold.",
    );
  }
  if (!/^[a-f0-9]{64}$/i.test(irn)) {
    return fail(
      "e_invoice",
      "E-invoice IRN",
      `The IRN "${irn}" is not a 64-character hexadecimal hash.`,
    );
  }
  const ackNumber = String(fields.e_invoice_ack_number ?? "").trim();
  if (ackNumber && !/^\d{12}$/.test(ackNumber)) {
    return warn(
      "e_invoice",
      "E-invoice IRN",
      `Acknowledgement number "${ackNumber}" is not 12 digits.`,
    );
  }
  const ackDate = String(fields.e_invoice_ack_date ?? "").trim();
  if (ackDate && Number.isNaN(new Date(ackDate).getTime())) {
    return warn("e_invoice", "E-invoice IRN", `Acknowledgement date "${ackDate}" is not a date.`);
  }
  return pass("e_invoice", "E-invoice IRN", "IRN is present and well formed.");
}

function eWayRule(
  docType: DocType,
  fields: FieldMap,
  settings: TenantSettings,
  today: Date,
): RuleResult {
  const total = toMinor(fields.total);
  const number = String(fields.eway_bill_number ?? "").trim();
  if (number && !/^\d{12}$/.test(number)) {
    return fail(
      "e_way_bill",
      "E-way bill consistency",
      `E-way bill number "${number}" is not 12 digits.`,
    );
  }
  const validUntil = String(fields.eway_valid_until ?? "").trim();
  if (validUntil) {
    const until = new Date(validUntil);
    if (Number.isNaN(until.getTime())) {
      return warn(
        "e_way_bill",
        "E-way bill consistency",
        `E-way bill validity "${validUntil}" is not a date.`,
      );
    }
    if (until.getTime() < today.getTime()) {
      return fail(
        "e_way_bill",
        "E-way bill consistency",
        "The e-way bill had expired before this document was processed.",
      );
    }
  }
  const vehicle = String(fields.vehicle_number ?? "").trim();
  if (vehicle && !/^[A-Z]{2}\d{2}[A-Z]{1,2}\d{4}$/i.test(vehicle.replace(/\s+/g, ""))) {
    return warn(
      "e_way_bill",
      "E-way bill consistency",
      `Vehicle number "${vehicle}" is not in the usual AA00AA0000 format.`,
    );
  }
  const required = docType === "e_way_bill" || total >= settings.gst.eWayThresholdMinor;
  if (!required) {
    return skip(
      "e_way_bill",
      "E-way bill consistency",
      "Invoice is below the e-way bill threshold.",
    );
  }
  if (!number) {
    return warn(
      "e_way_bill",
      "E-way bill consistency",
      "Consignment may need an e-way bill, but none is attached.",
    );
  }
  return pass("e_way_bill", "E-way bill consistency", "E-way bill is attached to the invoice.");
}

function tdsRule(fields: FieldMap): RuleResult {
  const category = String(fields.vendor_category ?? "goods");
  const amount = toMinor(fields.total);
  if (category === "goods")
    return skip("tds", "TDS applicability", "Purchase of goods; no TDS on this invoice.");
  if (amount > 3_000_000 && !fields.tds_section) {
    return warn(
      "tds",
      "TDS applicability",
      "Vendor category and value suggest TDS, but no section is captured.",
    );
  }
  return pass(
    "tds",
    "TDS applicability",
    "TDS position looks consistent with the vendor category.",
  );
}

function dateSanityRule(fields: FieldMap, settings: TenantSettings, today: Date): RuleResult {
  const value = String(fields.invoice_date ?? "");
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    return fail("date_sanity", "Date sanity", "Invoice date is missing or not a valid date.");
  }
  if (date.getTime() > today.getTime() + 86_400_000) {
    return fail("date_sanity", "Date sanity", `Invoice date ${value} is in the future.`);
  }
  const fyStart = new Date(settings.gst.fyStart);
  if (!Number.isNaN(fyStart.getTime()) && date < fyStart) {
    return fail(
      "date_sanity",
      "Date sanity",
      `Invoice date falls before the open financial period (${settings.gst.fyStart}).`,
    );
  }
  return pass("date_sanity", "Date sanity", "Invoice date is inside the open financial period.");
}

function bankStatementRules(input: RuleInput): RuleResult[] {
  const { fields, confidences, existing } = input;
  const rules: RuleResult[] = [
    mandatoryRule(fields, "bank_statement"),
    (() => {
      const debit = toMinor(fields.debit);
      const credit = toMinor(fields.credit);
      if (debit > 0 && credit > 0) {
        return fail(
          "amount_direction",
          "Debit or credit",
          "A statement line cannot be both a debit and a credit.",
        );
      }
      if (debit === 0 && credit === 0) {
        return fail("amount_direction", "Debit or credit", "The statement line has no amount.");
      }
      return pass(
        "amount_direction",
        "Debit or credit",
        "Statement line has a single clear direction.",
      );
    })(),
    (() => {
      const reference = String(fields.reference_number ?? "").trim();
      if (!reference)
        return skip(
          "bank_duplicate",
          "Duplicate statement line",
          "No reference number to compare.",
        );
      const match = (existing ?? []).find((record) =>
        String(record.title ?? "")
          .toLowerCase()
          .includes(reference.toLowerCase()),
      );
      return match
        ? fail(
            "bank_duplicate",
            "Duplicate statement line",
            `Reference ${reference} already appears in an earlier record.`,
          )
        : pass("bank_duplicate", "Duplicate statement line", "No matching statement line found.");
    })(),
  ];

  if ((confidences.total ?? 1) < 0.8) {
    rules.push(
      warn("amount_confidence", "Amount confidence", "The amount was read with low confidence."),
    );
  }
  return rules;
}

export function evaluateDocument(input: RuleInput): RuleResult[] {
  const { docType, fields, settings, existing = [], today = new Date(), match } = input;

  if (docType === "bank_statement") {
    return [...bankStatementRules(input), dateSanityRule(fields, settings, today)];
  }

  const totalMinor = toMinor(fields.total);

  const rules: RuleResult[] = [
    mandatoryRule(fields, docType),
    gstinFormatRule(fields),
    gstinStatusRule(fields),
    placeOfSupplyRule(fields),
    taxArithmeticRule(fields, settings),
    lineTotalRule(fields, settings),
    totalArithmeticRule(fields, settings),
    hsnRule(fields, settings),
    duplicateRule(fields, existing, totalMinor),
    threeWayMatchRule(fields, match?.threeWay),
    gstr2bRule(match?.gstr2b),
    eInvoiceRule(docType, fields, settings),
    eWayRule(docType, fields, settings, today),
    tdsRule(fields),
    dateSanityRule(fields, settings, today),
  ];

  return rules;
}

export function summarizeRules(rules: RuleResult[]): {
  failed: RuleResult[];
  warned: RuleResult[];
} {
  return {
    failed: rules.filter((rule) => rule.outcome === "fail"),
    warned: rules.filter((rule) => rule.outcome === "warn"),
  };
}
