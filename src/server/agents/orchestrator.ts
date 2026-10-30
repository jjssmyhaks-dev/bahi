import { z } from "zod";

import { PROMPT_VERSIONS, orchestratorPrompt } from "./prompts";
import { runAgent, type AgentDefinition } from "./runner.server";
import type { AgentOutput, OrchestratorIntent, RunContext } from "./types";

export const orchestratorSchema = z.object({
  intent: z.enum([
    "approve",
    "reject",
    "hold",
    "correct",
    "status",
    "help",
    "understand",
    "unknown",
  ]),
  targets: z.array(z.number().int().min(1).max(50)).max(20),
  destination: z.enum(["tally", "excel", "google_sheets"]).nullable(),
  field: z.string().nullable(),
  value: z.string().nullable(),
  reason: z.string().nullable(),
  reply: z.string().max(400).nullable(),
});

export interface OrchestratorInput {
  message: string;
  pending: {
    id: string;
    title: string;
    status: string;
    vendorName?: string;
    invoiceNumber?: string;
    amountMinor?: number;
  }[];
  documents: { id: string; filename: string; status: string }[];
}

const FIELD_ALIASES: Record<string, string> = {
  supplier: "vendor_name",
  "supplier name": "vendor_name",
  vendor: "vendor_name",
  gstin: "vendor_gstin",
  "gst number": "vendor_gstin",
  amount: "total",
  "invoice total": "total",
  "bill number": "invoice_number",
  "invoice no": "invoice_number",
  date: "invoice_date",
};

const ALLOWED_FIELDS = new Set([
  "vendor_name",
  "vendor_gstin",
  "invoice_number",
  "invoice_date",
  "total",
]);

function emptyIntent(): OrchestratorIntent {
  return {
    intent: "unknown",
    targets: [],
    destination: null,
    field: null,
    value: null,
    reason: null,
    reply: null,
  };
}

function fallback(): AgentOutput<OrchestratorIntent> {
  return {
    result: emptyIntent(),
    envelope: {
      confidence: 0,
      warnings: [],
      reason:
        "The deterministic command parser is the first line; the orchestrator did not add an intent.",
    },
  };
}

export const orchestratorAgent: AgentDefinition<OrchestratorInput, OrchestratorIntent> = {
  id: "chat_orchestrator",
  promptVersion: PROMPT_VERSIONS.chat_orchestrator,
  schema: orchestratorSchema,
  fallback,
  buildPrompt: (input, context) => orchestratorPrompt(context, input),
};

export function sanitiseIntent(
  result: OrchestratorIntent,
  pendingCount: number,
): OrchestratorIntent {
  const targets = [...new Set(result.targets)].filter(
    (target) => target >= 1 && target <= pendingCount,
  );
  const field = result.field ? (FIELD_ALIASES[result.field.toLowerCase()] ?? result.field) : null;
  const safeField = field && ALLOWED_FIELDS.has(field) ? field : null;

  if (["approve", "reject", "hold", "correct"].includes(result.intent) && targets.length === 0) {
    return {
      ...emptyIntent(),
      intent: "understand",
      reply:
        pendingCount === 1
          ? "I can do that. Should I apply it to the record waiting for review?"
          : "Which record should I apply that to? Tell me its number or supplier name.",
    };
  }

  if (result.intent === "correct" && (!safeField || !result.value?.trim())) {
    return {
      ...emptyIntent(),
      intent: "understand",
      reply: "Which field should I change, and what is the correct value?",
    };
  }

  return {
    ...result,
    targets,
    field: safeField,
    value: result.value?.trim() || null,
    reason: result.reason?.trim() || null,
    reply: result.reply?.trim() || null,
  };
}

export async function runOrchestrator(
  context: RunContext,
  input: OrchestratorInput,
): Promise<AgentOutput<OrchestratorIntent>> {
  const output = await runAgent(orchestratorAgent, input, context);
  return { ...output, result: sanitiseIntent(output.result, input.pending.length) };
}
