import type { SessionUser } from "@/lib/types";
import type { AgentId, RunContext } from "../types";
import { traceTool } from "../tracing.server";
import { findToolCall, insertToolCall } from "./store.server";
import type { ToolDefinition, ToolResult } from "./types";
import { fail } from "./types";

export interface ToolCallChip {
  name: string;
  kind: "read" | "write";
  status: "ok" | "error";
  summary: string;
  errorCode?: string | null | undefined;
  durationMs: number;
  replayed: boolean;
}

export interface ToolRunOutcome {
  result: ToolResult;
  chip: ToolCallChip;
}

function idempotencyKeyFor(rawArgs: unknown): string | null {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return null;
  const value = (rawArgs as Record<string, unknown>)["idempotency_key"];
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : null;
}

function storableResult(result: ToolResult): unknown {
  if (!result.ok) return null;
  const text = JSON.stringify(result.result);
  return text && text.length <= 8_000 ? result.result : null;
}

/**
 * Executes one tool call: errors become typed results, write calls are recorded
 * with their idempotency key, and a repeat of a successful write is replayed.
 */
export async function executeTool(input: {
  tool: ToolDefinition;
  agent: AgentId;
  args: unknown;
  run: RunContext;
  session: SessionUser | null;
}): Promise<ToolRunOutcome> {
  const { tool, agent, args, run, session } = input;
  const key = tool.kind === "write" ? idempotencyKeyFor(args) : null;

  if (tool.kind === "write" && !key) {
    const missing = fail(
      "invalid_arguments",
      "Write tools need an idempotency_key so a retry cannot repeat the action.",
    );
    await insertToolCall(run, {
      agent,
      tool: tool.name,
      kind: tool.kind,
      status: "error",
      summary: missing.error.message,
      errorCode: missing.error.code,
      idempotencyKey: null,
      durationMs: 0,
      result: null,
    });
    return {
      result: missing,
      chip: {
        name: tool.name,
        kind: tool.kind,
        status: "error",
        summary: missing.error.message,
        errorCode: missing.error.code,
        durationMs: 0,
        replayed: false,
      },
    };
  }

  if (key) {
    const previous = await findToolCall(run.schema, tool.name, key);
    if (previous) {
      const chip: ToolCallChip = {
        name: tool.name,
        kind: tool.kind,
        status: "ok",
        summary: previous.summary ?? "Already done.",
        durationMs: 0,
        replayed: true,
      };
      return {
        result: {
          ok: true,
          result: previous.result,
          summary: chip.summary,
          idempotentReplay: true,
        },
        chip,
      };
    }
  }

  const started = Date.now();
  const result = await tool.run(args, { run, session });
  const durationMs = Date.now() - started;
  const errorCode = result.ok ? null : result.error.code;
  const summary = result.ok ? result.summary : result.error.message;

  await insertToolCall(run, {
    agent,
    tool: tool.name,
    kind: tool.kind,
    status: result.ok ? "ok" : "error",
    summary,
    errorCode,
    idempotencyKey: key,
    durationMs,
    result: tool.kind === "write" ? storableResult(result) : null,
  });
  void traceTool({
    agent,
    traceId: run.traceId,
    tool: tool.name,
    kind: tool.kind,
    status: result.ok ? "ok" : "error",
    durationMs,
    errorCode,
  });

  return {
    result,
    chip: {
      name: tool.name,
      kind: tool.kind,
      status: result.ok ? "ok" : "error",
      summary,
      errorCode,
      durationMs,
      replayed: false,
    },
  };
}
