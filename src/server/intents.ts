import type { Destination } from "@/lib/types";

export interface PendingRef {
  id: string;
  title: string;
  vendorName?: string;
  invoiceNumber?: string;
  amountMinor?: number;
}

export type ChatAction =
  | { type: "none" }
  | { type: "question"; question: string }
  | { type: "approve"; targets: number[] | "all"; destination?: Destination }
  | { type: "reject"; targets: number[] | "all"; reason: string }
  | { type: "hold"; targets: number[] | "all"; note: string }
  | { type: "correct"; field: string; value: string; target: number | null };

const ORDINALS: Record<string, number> = {
  first: 0,
  "1st": 0,
  one: 0,
  second: 1,
  "2nd": 1,
  two: 1,
  third: 2,
  "3rd": 2,
  three: 2,
  fourth: 3,
  "4th": 3,
  four: 3,
  fifth: 4,
  "5th": 4,
  five: 4,
};

const FIELD_ALIASES: Record<string, string> = {
  vendor: "vendor_name",
  "vendor name": "vendor_name",
  supplier: "vendor_name",
  "supplier name": "vendor_name",
  gstin: "vendor_gstin",
  "gst number": "vendor_gstin",
  "invoice number": "invoice_number",
  "invoice no": "invoice_number",
  "bill number": "invoice_number",
  "document number": "invoice_number",
  "invoice date": "invoice_date",
  date: "invoice_date",
  total: "total",
  amount: "total",
  "invoice total": "total",
};

function detectDestination(text: string): Destination | undefined {
  if (/\btally(?:prime)?\b/i.test(text)) return "tally";
  if (/\bexcel\b|xlsx|workbook/i.test(text)) return "excel";
  if (/\bgoogle\s*sheets?\b|\bsheets?\b/i.test(text)) return "google_sheets";
  return undefined;
}

function resolveTargets(text: string, records: PendingRef[]): number[] | "all" | null {
  const lower = text.toLowerCase();
  if (/\b(all|everything|them|these|both)\b/.test(lower)) return records.length ? "all" : [];

  const numbered = lower.match(/(?:record|item|#)\s*(\d+)/);
  if (numbered) {
    const index = Number(numbered[1]) - 1;
    return index >= 0 && index < records.length ? [index] : null;
  }

  for (const [word, index] of Object.entries(ORDINALS)) {
    if (new RegExp(`\\b${word}\\b`).test(lower)) {
      return index < records.length ? [index] : null;
    }
  }

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    const haystacks = [record.vendorName, record.invoiceNumber, record.title]
      .filter(Boolean)
      .map((value) => value!.toLowerCase());
    const tokens = haystacks
      .join(" ")
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 3);
    if (tokens.some((token) => lower.includes(token))) return [i];
  }

  if (records.length === 1) return [0];
  return null;
}

function labelFor(record: PendingRef, index: number): string {
  return `${index + 1}. ${record.title}`;
}

function normaliseValue(field: string, value: string): string {
  const cleaned = value
    .replace(/^["'“”]+|["'“”.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (field === "vendor_gstin") return cleaned.toUpperCase();
  return cleaned;
}

/**
 * Understands chat commands about records that are already in the conversation.
 * When the target is unclear it returns a question instead of acting on a guess.
 */
export function parseChatAction(input: string, records: PendingRef[]): ChatAction {
  const text = input.trim();
  if (!text) return { type: "none" };
  const lower = text.toLowerCase();
  const destination = detectDestination(text);

  const changeMatch = text.match(
    /(?:change|set|update)\s+(?:the\s+)?(vendor name|vendor|supplier name|supplier|gstin|gst number|invoice number|invoice no|bill number|document number|invoice date|date|invoice total|total|amount)\s+(?:to|is|=)\s+(.+)$/i,
  );
  const isMatch = text.match(
    /(?:the\s+)?(vendor name|vendor|supplier name|supplier|gstin|gst number|invoice number|invoice no|bill number|document number|invoice date|date|invoice total|total|amount)\s+(?:is|should be)\s+(.+?)(?:\s*,?\s*not\s+(.+))?$/i,
  );

  const correction = changeMatch ?? isMatch;
  if (correction) {
    const field = FIELD_ALIASES[correction[1]!.toLowerCase()] ?? correction[1]!.toLowerCase();
    const value = normaliseValue(field, correction[2] ?? "");
    if (!value) return { type: "question", question: "What should I change it to?" };
    const targetList = resolveTargets(text, records);
    if (targetList === "all") {
      if (records.length > 1) {
        return {
          type: "question",
          question: `Which record should I update? ${records.map(labelFor).join(" · ")}`,
        };
      }
      return { type: "correct", field, value, target: 0 };
    }
    if (targetList === null) {
      return {
        type: "question",
        question: `I can update that, but I need to know which record. ${records
          .map(labelFor)
          .join(" · ")}. Say "change the supplier on the first one to ${value}".`,
      };
    }
    return { type: "correct", field, value, target: targetList[0] ?? null };
  }

  const reject = /\b(reject|discard|delete|remove|don't post|do not post)\b/i.test(lower);
  const hold = /\b(hold|park|wait)\b/i.test(lower);
  const approve = /\b(approve|accept|confirm|post|write|send it|go ahead)\b/i.test(lower);

  if (reject) {
    const targets = resolveTargets(text, records);
    if (targets === null) {
      return {
        type: "question",
        question: `Which record should I reject? ${records.map(labelFor).join(" · ")}`,
      };
    }
    const reason =
      text.match(/(?:because|since|reason[:\s]+)\s*(.+)$/i)?.[1]?.trim() ??
      text.match(/[-–—]\s*(.+)$/)?.[1]?.trim() ??
      "Rejected in the chat.";
    return { type: "reject", targets, reason };
  }

  if (hold) {
    const targets = resolveTargets(text, records);
    if (targets === null) {
      return {
        type: "question",
        question: `Which record should I hold? ${records.map(labelFor).join(" · ")}`,
      };
    }
    return { type: "hold", targets, note: "Held from the chat." };
  }

  if (approve) {
    const targets = resolveTargets(text, records);
    if (targets === null) {
      return {
        type: "question",
        question: `Which one should I approve? ${records.map(labelFor).join(" · ")}`,
      };
    }
    return { type: "approve", targets, ...(destination ? { destination } : {}) };
  }

  return { type: "none" };
}

export function looksLikeInvoiceText(text: string): boolean {
  const hasGstin = /\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/.test(text);
  const hasInvoiceWords = /(invoice|bill|taxable|gstin|vendor|supplier)/i.test(text);
  const hasMoney = /(total|amount|₹|rs\.?)\s*[:₹]?\s*[\d,]+/i.test(text);
  return (hasGstin && hasInvoiceWords) || (hasInvoiceWords && hasMoney);
}
