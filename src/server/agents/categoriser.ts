import { z } from "zod";

import { agentsEnabled } from "./config";
import { PROMPT_VERSIONS, categoriserPrompt } from "./prompts";
import { runAgent, type AgentDefinition } from "./runner.server";
import { listMasters } from "./store.server";
import type { AgentOutput, CategoriserResult, CategoryResult, RunContext } from "./types";

const categorySchema = z.enum([
  "vendor_payment",
  "bank_charge",
  "interest",
  "tax",
  "transfer",
  "unknown",
]);

export const categoriserSchema = z.object({
  lines: z.array(
    z.object({
      index: z.number().int().min(0),
      category: categorySchema,
      ledger: z.string().nullable(),
      matchedVendor: z.string().nullable(),
      confidence: z.number().min(0).max(1),
      reason: z.string().max(400),
    }),
  ),
});

export interface BankLine {
  narration: string;
  debit: number;
  credit: number;
  date?: string;
}

export interface CategoriserInput {
  lines: BankLine[];
  vendors: { name: string; ledger: string | null }[];
  ledgers: string[];
}

function lineResult(index: number, input: CategoriserInput, line: BankLine): CategoryResult {
  const text = line.narration.toLowerCase();

  if (/bank charge|charges|chg|sms charge|service charge|gst on charges/i.test(text)) {
    return {
      index,
      category: "bank_charge",
      ledger: "Bank Charges",
      matchedVendor: null,
      confidence: 0.98,
      reason: "Narration says this is a bank charge.",
    };
  }

  if (/interest|int\.?\s*pd|int credit/i.test(text)) {
    return {
      index,
      category: "interest",
      ledger: "Interest Income",
      matchedVendor: null,
      confidence: 0.96,
      reason: "Narration says this is interest.",
    };
  }

  const vendor = input.vendors.find((candidate) => {
    const name = candidate.name.toLowerCase();
    return (
      name.length >= 4 &&
      (text.includes(name) ||
        name.split(/\s+/).some((part) => part.length > 4 && text.includes(part)))
    );
  });
  if (vendor) {
    return {
      index,
      category: "vendor_payment",
      ledger: vendor.ledger ?? vendor.name,
      matchedVendor: vendor.name,
      confidence: 0.9,
      reason: `Narration names ${vendor.name}.`,
    };
  }

  if (/\b(gst|tds|tcs|advance tax|income tax)\b/i.test(text)) {
    return {
      index,
      category: "tax",
      ledger: "Suspense",
      matchedVendor: null,
      confidence: 0.65,
      reason: "Narration mentions a tax payment; the exact ledger needs confirmation.",
    };
  }

  if (/neft|rtgs|imps|upi|transfer|atm|cash/i.test(text)) {
    return {
      index,
      category: "transfer",
      ledger: "Suspense",
      matchedVendor: null,
      confidence: 0.55,
      reason: "Bank transfer to an unknown payee.",
    };
  }

  return {
    index,
    category: "unknown",
    ledger: null,
    matchedVendor: null,
    confidence: 0.3,
    reason: "The narration does not match a known payee or category.",
  };
}

function fallback(input: CategoriserInput): AgentOutput<CategoriserResult> {
  const lines = input.lines.map((line, index) => lineResult(index, input, line));
  const unresolved = lines.filter((line) => line.confidence < 0.7).length;
  return {
    result: { lines },
    envelope: {
      confidence: lines.length
        ? lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length
        : 0,
      warnings: unresolved
        ? [
            `${unresolved} bank line${unresolved === 1 ? " needs" : "s need"} a ledger confirmed by a person.`,
          ]
        : [],
      reason: `Categorised ${lines.length} bank line${lines.length === 1 ? "" : "s"} from narration and known masters.`,
    },
  };
}

export const categoriserAgent: AgentDefinition<CategoriserInput, CategoriserResult> = {
  id: "bank_categoriser",
  promptVersion: PROMPT_VERSIONS.bank_categoriser,
  schema: categoriserSchema,
  fallback,
  buildPrompt: (input, context) =>
    categoriserPrompt(context, {
      lines: input.lines,
      vendors: input.vendors.map((vendor) => vendor.name),
      ledgers: input.ledgers,
    }),
};

export async function loadCategoriserInput(
  context: RunContext,
  lines: BankLine[],
): Promise<CategoriserInput> {
  const [vendors, ledgers] = await Promise.all([
    listMasters(context.schema, "vendor"),
    listMasters(context.schema, "ledger"),
  ]);
  return {
    lines,
    vendors: vendors.map((vendor) => ({ name: vendor.name, ledger: vendor.ledger })),
    ledgers: ledgers.map((ledger) => ledger.name),
  };
}

export async function runCategoriser(
  context: RunContext,
  input: CategoriserInput,
): Promise<AgentOutput<CategoriserResult>> {
  const deterministic = fallback(input);
  if (!agentsEnabled() || deterministic.result.lines.every((line) => line.confidence >= 0.9)) {
    return deterministic;
  }

  const output = await runAgent(categoriserAgent, input, context);
  const merged = new Map<number, CategoryResult>();
  let replaced = 0;

  for (const line of output.result.lines) {
    if (line.index < 0 || line.index >= input.lines.length || merged.has(line.index)) {
      replaced += 1;
      continue;
    }
    merged.set(line.index, line);
  }

  const lines = input.lines.map(
    (_, index) => merged.get(index) ?? deterministic.result.lines[index]!,
  );
  if (lines.some((line) => !line)) return deterministic;

  return {
    ...output,
    result: { lines },
    envelope:
      replaced > 0
        ? {
            ...output.envelope,
            warnings: [
              ...output.envelope.warnings,
              "Some categoriser output did not match the statement lines and was replaced.",
            ],
          }
        : output.envelope,
  };
}
