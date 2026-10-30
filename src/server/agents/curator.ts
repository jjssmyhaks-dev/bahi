import { z } from "zod";

import { agentsEnabled } from "./config";
import { PROMPT_VERSIONS, curatorPrompt } from "./prompts";
import { runAgent, type AgentDefinition } from "./runner.server";
import { correctionGroups, saveRuleProposal, type CorrectionGroup } from "./store.server";
import type { AgentOutput, CuratorResult, CuratorRule, RunContext } from "./types";

const ruleSchema = z.object({
  kind: z.enum(["vendor_ledger", "field_default", "sheet_columns"]),
  scope: z.string().min(1).max(160),
  field: z.string().min(1).max(80),
  value: z.string().min(1).max(300),
  evidenceCount: z.number().int().min(1).max(10_000),
  example: z.string().max(400),
  description: z.string().max(400),
});

export const curatorSchema = z.object({
  rules: z.array(ruleSchema).max(30),
});

export interface CuratorInput {
  groups: CorrectionGroup[];
}

function descriptionFor(group: CorrectionGroup): string {
  if (group.field === "ledger") {
    return `When ${group.vendorKey} appears, use ledger "${group.newValue}".`;
  }
  return `For ${group.vendorKey}, prefer ${group.field.replace(/_/g, " ")} "${group.newValue}" while the document value is unclear.`;
}

export function proposeRules(groups: CorrectionGroup[]): CuratorRule[] {
  const rules: CuratorRule[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    if (group.count < 3 || group.vendorKey === "unknown") continue;
    const kind = group.field === "ledger" ? "vendor_ledger" : "field_default";
    const key = `${kind}|${group.vendorKey}|${group.field}|${group.newValue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({
      kind,
      scope: group.vendorKey,
      field: group.field,
      value: group.newValue,
      evidenceCount: group.count,
      example: group.example,
      description: descriptionFor(group),
    });
    if (rules.length >= 12) break;
  }

  return rules;
}

function fallback(input: CuratorInput): AgentOutput<CuratorResult> {
  const rules = proposeRules(input.groups);
  const ignored = input.groups.filter((group) => group.count < 3).length;
  return {
    result: { rules },
    envelope: {
      confidence: rules.length ? 0.9 : 0.5,
      warnings: ignored
        ? [
            `${ignored} correction group${ignored === 1 ? " has" : "s have"} fewer than three repeats and were not proposed.`,
          ]
        : [],
      reason: `${rules.length} rule${rules.length === 1 ? "" : "s"} proposed from repeated corrections.`,
    },
  };
}

export const curatorAgent: AgentDefinition<CuratorInput, CuratorResult> = {
  id: "learning_curator",
  promptVersion: PROMPT_VERSIONS.learning_curator,
  schema: curatorSchema,
  fallback,
  buildPrompt: (input, context) => curatorPrompt(context, { groups: input.groups }),
};

export interface CuratorOutcome {
  output: AgentOutput<CuratorResult>;
  saved: number;
}

export async function runCurator(context: RunContext): Promise<CuratorOutcome> {
  const groups = await correctionGroups(context.schema, 30);
  const input: CuratorInput = { groups };
  const output =
    groups.length && agentsEnabled()
      ? await runAgent(curatorAgent, input, context)
      : fallback(input);

  const rules = output.result.rules
    .filter((rule) => rule.evidenceCount >= 3 && rule.scope && rule.field && rule.value)
    .slice(0, 20);

  for (const rule of rules) await saveRuleProposal(context.schema, rule);
  return {
    output: {
      ...output,
      result: { rules },
      envelope: {
        ...output.envelope,
        warnings: [
          ...output.envelope.warnings,
          ...(rules.length
            ? ["A supervisor must confirm each proposed rule before it is used."]
            : ["No repeated correction reached the three-evidence threshold."]),
        ],
      },
    },
    saved: rules.length,
  };
}
