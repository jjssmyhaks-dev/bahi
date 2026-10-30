import { z } from "zod";

import { AGENT_LIMITS, AGENT_POLICIES, agentsEnabled, modelFor } from "./config";
import { callModelJson, callModelWithTools, estimateCostUsd, ModelError } from "./provider.server";
import { executeTool } from "./tools/executor";
import { toolsForAgent } from "./tools";
import { insertAgentRun } from "./store.server";
import { traceRun } from "./tracing.server";
import type {
  AgentEnvelope,
  AgentId,
  AgentMode,
  AgentOutput,
  RunContext,
  ToolCallSummary,
} from "./types";

export interface AgentDefinition<TInput, TResult> {
  id: AgentId;
  promptVersion: string;
  schema: z.ZodTypeAny;
  fallback: (
    input: TInput,
    context: RunContext,
  ) => AgentOutput<TResult> | Promise<AgentOutput<TResult>>;
  buildPrompt: (input: TInput, context: RunContext) => { system: string; user: string };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function normaliseEnvelope(envelope: AgentEnvelope): AgentEnvelope {
  return {
    confidence: clamp(envelope.confidence),
    warnings: envelope.warnings.filter((warning) => warning.trim().length > 0).slice(0, 12),
    reason: envelope.reason.slice(0, 500),
  };
}

/** Validation errors are reduced to paths and codes so no document text leaks. */
function describeError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "result"}: ${issue.code}`)
      .join("; ");
  }
  if (error instanceof ModelError) return error.message;
  return "The agent could not produce a valid result.";
}

function envelopeSchema(schema: z.ZodTypeAny) {
  return z.object({
    result: schema,
    confidence: z.number().min(0).max(1),
    warnings: z.array(z.string()).max(20),
    reason: z.string().max(2_000),
  });
}

/**
 * Runs one agent. Without an AI key the deterministic fallback is the agent.
 * With a key, the model output is validated; a schema failure gets exactly one
 * retry, after which the step is marked failed and the deterministic reader is
 * used with an escalation flag so the record cannot auto-post.
 */
export async function runAgent<TInput, TResult>(
  definition: AgentDefinition<TInput, TResult>,
  input: TInput,
  context: RunContext,
): Promise<AgentOutput<TResult>> {
  const policy = AGENT_POLICIES[definition.id];
  const model = modelFor(definition.id);
  const started = Date.now();

  if (!agentsEnabled()) {
    const output = await definition.fallback(input, context);
    return {
      result: output.result,
      envelope: normaliseEnvelope(output.envelope),
      escalated: false,
    };
  }

  let lastError = "The agent did not return a valid result.";
  let lastTokens = { input: 0, output: 0 };
  let attempts = 0;
  let toolWriteHappened = false;
  const tools = toolsForAgent(definition.id);

  for (let attempt = 0; attempt <= AGENT_LIMITS.retryCount; attempt++) {
    attempts = attempt + 1;
    const executed: ToolCallSummary[] = [];
    try {
      const prompt = definition.buildPrompt(input, context);
      const retryNotice =
        attempt === 0
          ? ""
          : `\n\nYour previous reply did not match the required schema. Problem: ${lastError}. Return one valid JSON object only.`;
      const reply = tools.length
        ? await callModelWithTools({
            model,
            system: prompt.system,
            user: `${prompt.user}${retryNotice}`,
            temperature: policy.temperature,
            maxTokens: policy.maxTokens,
            timeoutMs: policy.timeoutMs,
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
            maxToolCalls: AGENT_LIMITS.maxToolCalls,
            execute: async (name, args) => {
              const tool = tools.find((candidate) => candidate.name === name);
              if (!tool) {
                return {
                  ok: false,
                  summary: `The tool ${name} is not available to this agent.`,
                  result: {
                    code: "not_permitted",
                    message: "That tool is not registered for this agent.",
                  },
                };
              }
              const outcome = await executeTool({
                tool,
                agent: definition.id,
                args,
                run: context,
                session: context.session ?? null,
              });
              if (outcome.result.ok && tool.kind === "write") toolWriteHappened = true;
              executed.push({
                name: tool.name,
                kind: tool.kind,
                status: outcome.result.ok ? "ok" : "error",
                summary: outcome.chip.summary,
                durationMs: outcome.chip.durationMs,
                replayed: outcome.chip.replayed,
              });
              return {
                ok: outcome.result.ok,
                summary: outcome.chip.summary,
                result: outcome.result.ok ? outcome.result.result : outcome.result.error,
              };
            },
          })
        : await callModelJson({
            model,
            system: prompt.system,
            user: `${prompt.user}${retryNotice}`,
            temperature: policy.temperature,
            maxTokens: policy.maxTokens,
            timeoutMs: policy.timeoutMs,
          });
      lastTokens = { input: reply.inputTokens, output: reply.outputTokens };
      const parsed = envelopeSchema(definition.schema).parse(reply.json) as {
        result: TResult;
        confidence: number;
        warnings: string[];
        reason: string;
      };
      const latencyMs = Date.now() - started;
      const costUsd = estimateCostUsd(reply.model, reply.inputTokens, reply.outputTokens);
      const status: "success" | "retried" = attempt === 0 ? "success" : "retried";

      const runId = await insertAgentRun(context, {
        agent: definition.id,
        promptVersion: definition.promptVersion,
        model: reply.model,
        mode: "model",
        status,
        inputTokens: reply.inputTokens,
        outputTokens: reply.outputTokens,
        costUsd,
        latencyMs,
      });
      void traceRun(context, {
        agent: definition.id,
        traceId: context.traceId,
        model: reply.model,
        promptVersion: definition.promptVersion,
        mode: "model",
        status,
        latencyMs,
        inputTokens: reply.inputTokens,
        outputTokens: reply.outputTokens,
        costUsd,
      });

      return {
        result: parsed.result,
        envelope: normaliseEnvelope({
          confidence: parsed.confidence,
          warnings: parsed.warnings,
          reason: parsed.reason,
        }),
        escalated: false,
        runId,
        ...(tools.length ? { toolCalls: executed } : {}),
      };
    } catch (error) {
      lastError = describeError(error);
      const retryable =
        error instanceof z.ZodError || (error instanceof ModelError && error.status === 422);
      // A write already landed; replaying the turn could double-post through a new key.
      if (!retryable || toolWriteHappened) break;
    }
  }

  const fallback = await definition.fallback(input, context);
  const latencyMs = Date.now() - started;
  const costUsd = estimateCostUsd(model, lastTokens.input, lastTokens.output);
  const runId = await insertAgentRun(context, {
    agent: definition.id,
    promptVersion: definition.promptVersion,
    model,
    mode: "model",
    status: "failed",
    inputTokens: lastTokens.input,
    outputTokens: lastTokens.output,
    costUsd,
    latencyMs,
    error: lastError,
  });
  void traceRun(context, {
    agent: definition.id,
    traceId: context.traceId,
    model,
    promptVersion: definition.promptVersion,
    mode: "model",
    status: "failed",
    latencyMs,
    inputTokens: lastTokens.input,
    outputTokens: lastTokens.output,
    costUsd,
    error: lastError,
  });

  return {
    result: fallback.result,
    envelope: normaliseEnvelope({
      ...fallback.envelope,
      warnings: [
        ...fallback.envelope.warnings,
        `The AI model failed after ${attempts} attempt${attempts === 1 ? "" : "s"}, so Bahi used its deterministic reader. This record needs a person.`,
        ...(toolWriteHappened
          ? [
              "Some tool actions were already applied before the model failed; check the record before retrying.",
            ]
          : []),
      ],
      reason: `Model fallback: ${lastError}`,
    }),
    escalated: true,
    runId,
  };
}

export type { AgentMode };
