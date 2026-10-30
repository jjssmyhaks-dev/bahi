import { z } from "zod";

import type { FieldMap } from "@/lib/types";
import { agentsEnabled } from "./config";
import { PROMPT_VERSIONS, matcherPrompt } from "./prompts";
import { runAgent, type AgentDefinition } from "./runner.server";
import { nameSimilarity, normalizeName } from "./similarity";
import { confirmedVendorLedgers, listMasters } from "./store.server";
import type {
  AgentEnvelope,
  AgentOutput,
  MatchResult,
  MatcherCandidate,
  RunContext,
} from "./types";

const candidateSchema = z.object({
  name: z.string().min(1).max(160),
  gstin: z.string().nullable(),
  ledger: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export const matcherSchema = z.object({
  status: z.enum(["matched", "ambiguous", "new_party"]),
  vendor: candidateSchema.nullable(),
  alternatives: z.array(candidateSchema).max(10),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(600),
});

export interface MatcherInput {
  vendorName: string | null;
  vendorGstin: string | null;
  candidates: MatcherCandidate[];
  ledgerMap: Record<string, string>;
}

function scoreCandidate(input: MatcherInput, master: MatcherCandidate): MatcherCandidate {
  const gstin = input.vendorGstin?.trim().toUpperCase() ?? "";
  const name = input.vendorName?.trim() ?? "";
  let confidence = 0;

  if (gstin && master.gstin && master.gstin.toUpperCase() === gstin) confidence = 0.99;
  else if (name && normalizeName(master.name) === normalizeName(name)) confidence = 0.95;
  else if (name && nameSimilarity(master.name, name) >= 0.45) {
    confidence = 0.5 + 0.45 * nameSimilarity(master.name, name);
  }

  const ledger =
    input.ledgerMap[master.gstin ?? ""] ??
    input.ledgerMap[master.name] ??
    master.ledger ??
    master.name;

  return { ...master, ledger, confidence: Number(confidence.toFixed(3)) };
}

export function resolveMatch(input: MatcherInput): MatchResult {
  const scored = input.candidates
    .map((master) => scoreCandidate(input, master))
    .filter((candidate) => candidate.confidence >= 0.4)
    .sort((left, right) => right.confidence - left.confidence);

  const top = scored[0];
  const alternatives = scored.slice(1, 6);
  const supplier = input.vendorName ?? "This supplier";

  if (!top || top.confidence < 0.55) {
    return {
      status: "new_party",
      vendor: null,
      alternatives,
      confidence: Math.min(0.3, top?.confidence ?? 0.1),
      reason: `No existing supplier master matches ${supplier}${
        input.vendorGstin ? ` (${input.vendorGstin})` : ""
      }.`,
    };
  }

  if (top.confidence >= 0.9) {
    return {
      status: "matched",
      vendor: top,
      alternatives,
      confidence: top.confidence,
      reason:
        input.vendorGstin && top.gstin?.toUpperCase() === input.vendorGstin.toUpperCase()
          ? `GSTIN matched ${top.name}.`
          : `Name matched ${top.name}.`,
    };
  }

  return {
    status: "ambiguous",
    vendor: top,
    alternatives,
    confidence: top.confidence,
    reason: top.confidence
      ? `${supplier} is closest to ${top.name}, but the match is not certain.`
      : `${supplier} has no close master.`,
  };
}

function envelopeFor(result: MatchResult): AgentEnvelope {
  const warnings: string[] = [];
  if (result.status === "new_party") {
    warnings.push("No supplier master matches. A person must create or approve the party.");
  }
  if (result.status === "ambiguous") {
    const other = result.alternatives[0];
    warnings.push(
      other
        ? `The supplier could be ${result.vendor?.name ?? "one master"} or ${other.name}; confirm before posting.`
        : "The supplier match is below the confidence threshold.",
    );
  }
  if (result.status === "matched" && result.confidence < 0.8) {
    warnings.push("The supplier match is close but not certain.");
  }
  return { confidence: result.confidence, warnings, reason: result.reason };
}

function fallback(input: MatcherInput): AgentOutput<MatchResult> {
  const result = resolveMatch(input);
  return { result, envelope: envelopeFor(result) };
}

export const matcherAgent: AgentDefinition<MatcherInput, MatchResult> = {
  id: "master_matcher",
  promptVersion: PROMPT_VERSIONS.master_matcher,
  schema: matcherSchema,
  fallback,
  buildPrompt: (input, context) =>
    matcherPrompt(context, {
      vendorName: input.vendorName,
      vendorGstin: input.vendorGstin,
      candidates: input.candidates,
    }),
};

function candidateMatches(candidate: MatcherCandidate, input: MatcherInput): boolean {
  const name = input.vendorName ? normalizeName(input.vendorName) : "";
  return input.candidates.some(
    (master) =>
      (candidate.gstin &&
        master.gstin &&
        candidate.gstin.toUpperCase() === master.gstin.toUpperCase()) ||
      (name && normalizeName(master.name) === normalizeName(candidate.name)),
  );
}

export async function loadMatcherInput(
  context: RunContext,
  fields: Pick<FieldMap, "vendor_name" | "vendor_gstin">,
): Promise<MatcherInput> {
  const [masters, ledgerMap] = await Promise.all([
    listMasters(context.schema, "vendor"),
    confirmedVendorLedgers(context.schema),
  ]);
  return {
    vendorName: fields.vendor_name?.trim() || null,
    vendorGstin: fields.vendor_gstin?.trim() || null,
    candidates: masters.map((master) => ({
      name: master.name,
      gstin: master.gstin,
      ledger: master.ledger,
      confidence: 0,
    })),
    ledgerMap,
  };
}

/**
 * Exact GSTIN or name matches are resolved in code and cost no model call.
 * Only genuinely ambiguous suppliers reach the model, and a model choice that
 * is not in the candidate list is rejected.
 */
export async function runMatcher(
  context: RunContext,
  fields: Pick<FieldMap, "vendor_name" | "vendor_gstin">,
): Promise<AgentOutput<MatchResult>> {
  const input = await loadMatcherInput(context, fields);
  const deterministic = fallback(input);

  if (
    !agentsEnabled() ||
    !input.candidates.length ||
    (deterministic.result.status === "matched" && deterministic.result.confidence >= 0.95)
  ) {
    return deterministic;
  }

  const output = await runAgent(matcherAgent, input, context);
  const chosen = output.result.vendor;

  if (output.runId && chosen && !candidateMatches(chosen, input)) {
    return {
      result: deterministic.result,
      envelope: {
        ...deterministic.envelope,
        warnings: [
          ...deterministic.envelope.warnings,
          "The model chose a supplier that is not in the tenant's masters; the deterministic match was used instead.",
        ],
      },
      escalated: true,
      ...(output.runId ? { runId: output.runId } : {}),
    };
  }

  return output;
}
