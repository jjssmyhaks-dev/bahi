import { z } from "zod";

import { confirmedVendorLedgers, correctionGroups, listRuleProposals } from "../store.server";
import { defineTool, ok } from "./types";

export const getCorrectionGroupsTool = defineTool({
  name: "get_correction_groups",
  description:
    "Return corrections for the period grouped by vendor, field and corrected value, excluding one-offs.",
  kind: "read",
  agents: ["learning_curator"],
  schema: z.object({
    days: z.number().int().min(1).max(180).optional(),
  }),
  run: async (args, context) => {
    const groups = await correctionGroups(context.run.schema, args.days ?? 30);
    return ok({ groups }, `${groups.length} correction group${groups.length === 1 ? "" : "s"}`);
  },
});

export const getExistingRulesTool = defineTool({
  name: "get_existing_rules",
  description:
    "Return this workspace's current and proposed rules so the curator does not propose duplicates.",
  kind: "read",
  agents: ["learning_curator"],
  schema: z.object({}),
  run: async (_args, context) => {
    const [proposals, ledgers] = await Promise.all([
      listRuleProposals(context.run.schema),
      confirmedVendorLedgers(context.run.schema),
    ]);
    const rules = proposals.map((proposal) => ({
      id: proposal.id,
      status: proposal.status,
      kind: proposal.rule.kind,
      scope: proposal.rule.scope,
      field: proposal.rule.field,
      value: proposal.rule.value,
      evidenceCount: proposal.evidenceCount,
      description: proposal.rule.description,
    }));
    return ok(
      {
        rules,
        rememberedLedgers: Object.entries(ledgers).map(([party, ledger]) => ({ party, ledger })),
      },
      `${rules.length} rule${rules.length === 1 ? "" : "s"} on record`,
    );
  },
});

export const CURATOR_TOOLS = [getCorrectionGroupsTool, getExistingRulesTool];
