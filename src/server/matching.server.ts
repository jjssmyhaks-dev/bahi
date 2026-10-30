import type { DocType, FieldMap, LineItem } from "@/lib/types";
import { sql, table } from "./db.server";

export interface MatchCandidate {
  id: string;
  docType: DocType;
  title: string;
  fields: FieldMap;
}

export interface ThreeWayEvidence {
  poMatched: boolean;
  poNumber?: string;
  poReason: string;
  grMatched: boolean;
  grReason: string;
  poRecordId?: string;
  grRecordId?: string;
  varianceMinor?: number;
}

export interface Gstr2bEvidence {
  status: "matched" | "mismatch" | "missing_in_books" | "not_in_2b";
  period?: string;
  reason: string;
}

export interface DocumentEvidence {
  threeWay?: ThreeWayEvidence;
  gstr2b?: Gstr2bEvidence;
}

const norm = (value: unknown) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();

const money = (value: unknown) => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
};

function amountTolerance(total: number): number {
  return Math.max(100, Math.round(total * 0.01));
}

function lineSimilarity(left: LineItem, right: LineItem): number {
  const a = norm(left.description);
  const b = norm(right.description);
  if (a && b && (a === b || a.includes(b) || b.includes(a))) return 1;
  if (left.hsn && right.hsn && String(left.hsn) === String(right.hsn)) return 0.8;
  if (
    left.quantity &&
    right.quantity &&
    Math.abs(Number(left.quantity) - Number(right.quantity)) < 0.01 &&
    Math.abs(money(left.amount) - money(right.amount)) <= 1
  ) {
    return 0.7;
  }
  return 0;
}

function lineOverlap(invoice: LineItem[], order: LineItem[]): number {
  if (!invoice.length || !order.length) return 1;
  let matched = 0;
  for (const line of invoice) {
    if (order.some((candidate) => lineSimilarity(line, candidate) >= 0.7)) matched += 1;
  }
  return matched / invoice.length;
}

function documentNumber(fields: FieldMap): string {
  return String(
    fields.po_number ??
      fields.reference_number ??
      fields.invoice_number ??
      fields.challan_number ??
      "",
  ).trim();
}

function hasDocumentNumber(fields: FieldMap, number: string): boolean {
  if (!number) return false;
  const wanted = norm(number);
  return [
    fields.po_number,
    fields.reference_number,
    fields.invoice_number,
    fields.challan_number,
    fields.irn,
  ].some((value) => norm(value) === wanted);
}

function sameVendor(invoice: FieldMap, candidate: FieldMap): boolean {
  const gstin = String(invoice.vendor_gstin ?? "")
    .trim()
    .toUpperCase();
  if (gstin) {
    return (
      String(candidate.vendor_gstin ?? "")
        .trim()
        .toUpperCase() === gstin
    );
  }
  const name = norm(invoice.vendor_name);
  return Boolean(name) && norm(candidate.vendor_name) === name;
}

/**
 * Matches a supplier invoice against uploaded purchase orders and goods receipts.
 * Amounts are compared within ₹100 or 1%, whichever is larger.
 */
export function evaluateThreeWay(
  invoice: FieldMap,
  candidates: MatchCandidate[],
): ThreeWayEvidence {
  const orders = candidates.filter((candidate) => candidate.docType === "purchase_order");
  const receipts = candidates.filter((candidate) => candidate.docType === "goods_receipt");
  const total = money(invoice.total);
  const tolerance = amountTolerance(total);
  const poNumber = String(invoice.po_number ?? "").trim();

  let order = poNumber
    ? orders.find(
        (candidate) =>
          sameVendor(invoice, candidate.fields) && hasDocumentNumber(candidate.fields, poNumber),
      )
    : undefined;
  if (!order) {
    order = orders.find(
      (candidate) =>
        sameVendor(invoice, candidate.fields) &&
        Math.abs(money(candidate.fields.total) - total) <= tolerance &&
        lineOverlap(
          Array.isArray(invoice.line_items) ? invoice.line_items : [],
          Array.isArray(candidate.fields.line_items) ? candidate.fields.line_items : [],
        ) >= 0.5,
    );
  }

  let poMatched = false;
  let poReason = poNumber
    ? `Purchase order ${poNumber} is not among the uploaded records.`
    : "No purchase order is linked to this invoice.";
  let varianceMinor: number | undefined;
  if (order) {
    const orderTotal = money(order.fields.total);
    const difference = Math.round(Math.abs(orderTotal - total) * 100);
    if (difference <= tolerance * 100) {
      poMatched = true;
      poReason = `Matched purchase order ${documentNumber(order.fields) || order.title}.`;
    } else if (
      poNumber &&
      hasDocumentNumber(order.fields, poNumber) &&
      !sameVendor(invoice, order.fields)
    ) {
      poReason = `Purchase order ${poNumber} belongs to a different supplier.`;
    } else {
      varianceMinor = difference;
      poReason = `Purchase order total ₹${orderTotal.toFixed(2)} differs from the invoice total ₹${total.toFixed(2)}.`;
    }
  }

  let receipt = receipts.find((candidate) => {
    if (!sameVendor(invoice, candidate.fields)) return false;
    const reference = String(candidate.fields.po_number ?? candidate.fields.reference_number ?? "");
    if (poNumber && norm(reference) === norm(poNumber)) return true;
    if (
      invoice.challan_number &&
      hasDocumentNumber(candidate.fields, String(invoice.challan_number))
    ) {
      return true;
    }
    return false;
  });
  if (!receipt && poMatched) {
    receipt = receipts.find(
      (candidate) =>
        sameVendor(invoice, candidate.fields) &&
        Math.abs(money(candidate.fields.total) - total) <= tolerance,
    );
  }

  let grMatched = false;
  let grReason = poMatched
    ? "No goods receipt matches this purchase order yet."
    : "Goods receipt matching waits for a purchase order.";
  if (receipt) {
    const receiptTotal = money(receipt.fields.total);
    const difference = Math.abs(receiptTotal - total) * 100;
    if (difference <= tolerance * 100) {
      grMatched = true;
      grReason = `Matched goods receipt ${documentNumber(receipt.fields) || receipt.title}.`;
    } else {
      grReason = `Goods receipt total ₹${receiptTotal.toFixed(2)} differs from the invoice total ₹${total.toFixed(2)}.`;
    }
  }

  const matchedPoNumber = order ? documentNumber(order.fields) || poNumber : poNumber;
  return {
    poMatched,
    ...(matchedPoNumber ? { poNumber: matchedPoNumber } : {}),
    poReason,
    grMatched,
    grReason,
    ...(order ? { poRecordId: order.id } : {}),
    ...(receipt ? { grRecordId: receipt.id } : {}),
    ...(varianceMinor !== undefined ? { varianceMinor } : {}),
  };
}

/** Loads uploaded POs and GRs that could belong to this invoice. */
export async function loadMatchCandidates(
  schema: string,
  fields: FieldMap,
): Promise<MatchCandidate[]> {
  const gstin = String(fields.vendor_gstin ?? "")
    .trim()
    .toUpperCase();
  const poNumber = String(fields.po_number ?? "").trim();
  const rows = await sql<{
    id: string;
    doc_type: DocType;
    title: string;
    fields: FieldMap;
  }>(
    `select id, doc_type, title, fields from ${table(schema, "records")}
      where doc_type in ('purchase_order', 'goods_receipt')
        and status <> 'rejected'
        and (
          ($1 <> '' and upper(coalesce(fields->>'vendor_gstin', '')) = $1)
          or ($2 <> '' and lower(coalesce(fields->>'po_number', fields->>'reference_number', '')) = lower($2))
        )
      order by created_at desc
      limit 40`,
    [gstin, poNumber],
  );
  return rows.map((row) => ({
    id: row.id,
    docType: row.doc_type,
    title: row.title,
    fields: row.fields ?? {},
  }));
}

export async function findGstr2bMatch(
  schema: string,
  fields: FieldMap,
): Promise<Gstr2bEvidence | null> {
  const gstin = String(fields.vendor_gstin ?? "")
    .trim()
    .toUpperCase();
  const invoiceNumber = String(fields.invoice_number ?? "").trim();
  if (!gstin || !invoiceNumber) return null;
  try {
    const rows = await sql<{
      period: string;
      total: string;
      itc_status: string | null;
    }>(
      `select period, total::text as total, itc_status from ${table(schema, "gstr2b_lines")}
        where upper(supplier_gstin) = $1 and lower(invoice_number) = lower($2)
        order by period desc limit 1`,
      [gstin, invoiceNumber],
    );
    if (!rows.length) return null;
    const entry = rows[0]!;
    const total = money(fields.total);
    const tolerance = amountTolerance(total);
    if (Math.abs(Number(entry.total) - total) > tolerance) {
      return {
        status: "mismatch",
        period: entry.period,
        reason: `GSTR-2B shows ₹${Number(entry.total).toFixed(2)} for this invoice, but the books show ₹${total.toFixed(2)}.`,
      };
    }
    return {
      status: "matched",
      period: entry.period,
      reason: `Found in GSTR-2B for ${entry.period} with matching values.`,
    };
  } catch {
    // The reconciliation table is added by migration 0005; older databases skip this check.
    return null;
  }
}

export async function documentEvidence(
  schema: string,
  fields: FieldMap,
): Promise<DocumentEvidence> {
  const [candidates, gstr2b] = await Promise.all([
    loadMatchCandidates(schema, fields),
    findGstr2bMatch(schema, fields),
  ]);
  const threeWay = evaluateThreeWay(fields, candidates);
  return {
    threeWay,
    ...(gstr2b ? { gstr2b } : {}),
  };
}
