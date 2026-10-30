import type { Destination, DocType, RecordStatus, RuleOutcome } from "./types";

export function formatINR(minor: number, fraction = 0): string {
  const value = (minor ?? 0) / 100;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: fraction,
    maximumFractionDigits: fraction,
  }).format(value);
}

export function formatAmount(value: number | undefined): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(d);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function timeAgo(value: string | null | undefined): string {
  if (!value) return "";
  const diff = Date.now() - new Date(value).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(value);
}

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  supplier_invoice: "Supplier invoice",
  credit_note: "Credit note",
  purchase_order: "Purchase order",
  goods_receipt: "Goods receipt",
  e_way_bill: "E-way bill",
  e_invoice: "E-invoice",
  bank_statement: "Bank statement",
};

export const DESTINATION_LABELS: Record<Destination, string> = {
  tally: "TallyPrime",
  excel: "Excel",
  google_sheets: "Google Sheets",
};

export const STATUS_LABELS: Record<RecordStatus, string> = {
  pending_review: "Needs review",
  approved: "Approved",
  posted: "Posted to Tally",
  written: "Written",
  rejected: "Rejected",
  held: "On hold",
  failed: "Failed",
};

export function outcomeLabel(outcome: RuleOutcome): string {
  return outcome === "pass"
    ? "Passed"
    : outcome === "warn"
      ? "Warning"
      : outcome === "fail"
        ? "Failed"
        : "Not checked";
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function pct(n: number): string {
  return `${Math.round((n ?? 0) * 100)}%`;
}
