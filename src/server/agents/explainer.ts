import { z } from "zod";

import type { FieldMap, RuleResult } from "@/lib/types";
import { RULE_NEXT_STEPS } from "./pack";
import { PROMPT_VERSIONS, explainerPrompt } from "./prompts";
import { runAgent, type AgentDefinition } from "./runner.server";
import type { AgentOutput, ExplainerResult, RuleExplanation, RunContext } from "./types";

export const explainerSchema = z.object({
  explanations: z.array(
    z.object({
      ruleId: z.string().min(1).max(80),
      outcome: z.enum(["warn", "fail"]),
      reason: z.string().min(1).max(600),
      nextStep: z.string().max(400),
    }),
  ),
});

export interface ExplainerInput {
  docType: string;
  fields: FieldMap;
  rules: RuleResult[];
}

function flaggedRules(rules: RuleResult[]): (RuleResult & { outcome: "warn" | "fail" })[] {
  return rules.filter(
    (rule): rule is RuleResult & { outcome: "warn" | "fail" } =>
      rule.outcome === "warn" || rule.outcome === "fail",
  );
}

function explainOne(rule: RuleResult & { outcome: "warn" | "fail" }): RuleExplanation {
  return {
    ruleId: rule.id,
    outcome: rule.outcome,
    reason: rule.message,
    nextStep: RULE_NEXT_STEPS[rule.id] ?? "Check the value against the source document.",
  };
}

function fallback(input: ExplainerInput): AgentOutput<ExplainerResult> {
  const flagged = flaggedRules(input.rules);
  return {
    result: { explanations: flagged.map(explainOne) },
    envelope: {
      confidence: 0.95,
      warnings: [],
      reason: `${flagged.length} flagged rule${flagged.length === 1 ? "" : "s"} explained from the deterministic rule output.`,
    },
  };
}

export const explainerAgent: AgentDefinition<ExplainerInput, ExplainerResult> = {
  id: "validation_explainer",
  promptVersion: PROMPT_VERSIONS.validation_explainer,
  schema: explainerSchema,
  fallback,
  buildPrompt: (input, context) =>
    explainerPrompt(context, {
      docType: input.docType,
      rules: input.rules,
      fields: input.fields,
    }),
};

/**
 * Runs only when at least one rule warned or failed. Rule ids and outcomes from
 * the model must match the deterministic results; anything else is replaced.
 */
export async function runExplainer(
  context: RunContext,
  input: ExplainerInput,
): Promise<AgentOutput<ExplainerResult> | null> {
  const flagged = flaggedRules(input.rules);
  if (!flagged.length) return null;

  const output = await runAgent(explainerAgent, input, context);
  const expected = new Map(flagged.map((rule) => [`${rule.id}:${rule.outcome}`, rule]));
  const seen = new Set<string>();
  const merged: RuleExplanation[] = [];
  let replaced = 0;

  for (const explanation of output.result.explanations) {
    const key = `${explanation.ruleId}:${explanation.outcome}`;
    const rule = expected.get(key);
    if (!rule || seen.has(key)) {
      replaced += 1;
      continue;
    }
    seen.add(key);
    merged.push({
      ...explanation,
      reason: explanation.reason.trim() || rule.message,
      nextStep:
        explanation.nextStep.trim() ||
        RULE_NEXT_STEPS[rule.id] ||
        "Check the value against the source document.",
    });
  }

  for (const rule of flagged) {
    if (!seen.has(`${rule.id}:${rule.outcome}`)) merged.push(explainOne(rule));
  }

  return {
    ...output,
    result: { explanations: merged },
    envelope:
      replaced > 0
        ? {
            ...output.envelope,
            warnings: [
              ...output.envelope.warnings,
              "Some explanations did not match the deterministic rules and were replaced.",
            ],
          }
        : output.envelope,
  };
}
