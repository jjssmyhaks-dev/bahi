import type { DocType } from "@/lib/types";
import type { RunContext } from "./types";

export interface PackField {
  key: string;
  label: string;
  hint: string;
}

export interface IndustryPack {
  key: string;
  version: string;
  name: string;
  catalogue: DocType[];
  hints: string[];
  fields: Partial<Record<DocType, PackField[]>>;
}

const INVOICE_FIELDS: PackField[] = [
  { key: "vendor_name", label: "Supplier name", hint: "Printed seller name, exactly as written." },
  {
    key: "vendor_gstin",
    label: "Supplier GSTIN",
    hint: "15-character GSTIN printed on the invoice.",
  },
  { key: "invoice_number", label: "Invoice number", hint: "Document number, exactly as printed." },
  { key: "invoice_date", label: "Invoice date", hint: "Date of the invoice in dd/mm/yyyy or ISO." },
  {
    key: "place_of_supply",
    label: "Place of supply",
    hint: "State name with its two-digit GST code.",
  },
  {
    key: "line_items",
    label: "Line items",
    hint: "Description, HSN, quantity, unit, rate, amount and GST rate for each line.",
  },
  { key: "taxable_value", label: "Taxable value", hint: "Value before GST." },
  { key: "cgst", label: "CGST", hint: "Central GST amount." },
  { key: "sgst", label: "SGST", hint: "State GST amount." },
  { key: "igst", label: "IGST", hint: "Integrated GST amount." },
  { key: "round_off", label: "Round off", hint: "Rounding adjustment, zero when absent." },
  { key: "total", label: "Total", hint: "Invoice total including GST." },
  { key: "irn", label: "IRN", hint: "64-character invoice reference number, when e-invoiced." },
  { key: "eway_bill_number", label: "E-way bill", hint: "E-way bill number, when present." },
];

const BANK_FIELDS: PackField[] = [
  {
    key: "account_reference",
    label: "Account",
    hint: "Account name and number from the statement header.",
  },
  { key: "invoice_date", label: "Date", hint: "Transaction date." },
  { key: "narration", label: "Narration", hint: "Transaction narration exactly as printed." },
  { key: "reference_number", label: "Reference", hint: "Cheque, UPI or NEFT reference." },
  { key: "debit", label: "Debit", hint: "Money leaving the account, zero when blank." },
  { key: "credit", label: "Credit", hint: "Money entering the account, zero when blank." },
  { key: "balance", label: "Balance", hint: "Running balance after the transaction." },
  { key: "total", label: "Amount", hint: "Debit or credit value for the line." },
];

export const MANUFACTURING_PACK: IndustryPack = {
  key: "manufacturing",
  version: "1.0.0",
  name: "Manufacturing (India)",
  catalogue: [
    "supplier_invoice",
    "credit_note",
    "purchase_order",
    "goods_receipt",
    "e_way_bill",
    "e_invoice",
    "bank_statement",
  ],
  hints: [
    "Amounts on Indian invoices use commas in the lakh grouping, for example 1,18,000.00.",
    "GSTIN is 15 characters: two state digits, five letters, four digits, one letter, one alphanumeric, Z and a checksum character.",
    "Intra-state supplies carry CGST and SGST; inter-state supplies carry IGST.",
    "Ignore the round-off line when it is absent rather than inventing a value.",
    "Purchase orders and goods receipts pair with a supplier invoice and may omit tax amounts.",
  ],
  fields: {
    supplier_invoice: INVOICE_FIELDS,
    credit_note: INVOICE_FIELDS,
    e_invoice: INVOICE_FIELDS,
    purchase_order: [
      { key: "po_number", label: "PO number", hint: "Purchase order number." },
      { key: "vendor_name", label: "Supplier", hint: "Supplier named on the order." },
      { key: "vendor_gstin", label: "Supplier GSTIN", hint: "Supplier GSTIN when printed." },
      { key: "invoice_date", label: "Date", hint: "Order date." },
      { key: "line_items", label: "Line items", hint: "Ordered items with quantity and rate." },
    ],
    goods_receipt: [
      {
        key: "challan_number",
        label: "Challan number",
        hint: "Delivery challan or receipt number.",
      },
      { key: "vendor_name", label: "Supplier", hint: "Supplier named on the receipt." },
      { key: "invoice_date", label: "Date", hint: "Receipt date." },
      { key: "line_items", label: "Line items", hint: "Received items with quantity." },
    ],
    e_way_bill: [
      { key: "eway_bill_number", label: "E-way bill number", hint: "12 to 14 digit number." },
      { key: "vendor_gstin", label: "Supplier GSTIN", hint: "GSTIN of the consignor." },
      { key: "invoice_number", label: "Invoice number", hint: "Invoice the bill covers." },
      { key: "invoice_date", label: "Date", hint: "Generation date." },
      { key: "total", label: "Value", hint: "Consignment value." },
    ],
    bank_statement: BANK_FIELDS,
  },
};

export function packFor(context: RunContext): IndustryPack {
  if (context.pack.key === MANUFACTURING_PACK.key) {
    return { ...MANUFACTURING_PACK, version: context.pack.version };
  }
  return MANUFACTURING_PACK;
}

export function fieldGuide(pack: IndustryPack, docType: DocType | "unknown"): string {
  if (docType === "unknown") return "No field schema is available for an unknown document type.";
  const fields = pack.fields[docType] ?? [];
  return fields.map((field) => `- ${field.key} (${field.label}): ${field.hint}`).join("\n");
}

export const RULE_NEXT_STEPS: Record<string, string> = {
  mandatory_fields:
    "Ask the supplier for a complete document, or fill the missing field from the purchase order.",
  gstin_format:
    "Recheck the GSTIN against the document; a single wrong character makes it invalid.",
  gstin_status:
    "Ask the supplier for a valid, active GSTIN or a corrected invoice before approving.",
  tax_arithmetic:
    "Recalculate the tax split; CGST and SGST should each be half of the GST on an intra-state supply.",
  line_totals:
    "Check the quantity, rate and amount columns; the line amount should equal quantity times rate.",
  total_arithmetic:
    "Ask the supplier for a corrected invoice, or correct the total if the printed total is wrong.",
  hsn_rate: "Confirm the HSN code and its GST rate with the supplier.",
  duplicate_invoice:
    "Check whether this invoice was already entered; do not write a second voucher.",
  e_invoice:
    "For invoices above the e-invoice threshold, ask the supplier for the IRN and QR code.",
  e_way_bill:
    "For goods movement above the e-way bill threshold, ask the supplier for the e-way bill.",
  tds: "Confirm whether TDS applies and record the section before posting.",
  date_sanity:
    "Check the invoice date; it should be inside the current financial year and not in the future.",
  amount_direction:
    "Confirm whether the line is a payment or a receipt and fix the debit or credit column.",
  bank_duplicate: "Check the statement import; this line may already be entered.",
  amount_confidence:
    "Verify the amount against the source document; the read was not fully confident.",
};
