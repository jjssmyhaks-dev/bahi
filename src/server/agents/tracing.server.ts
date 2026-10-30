import { randomUUID } from "node:crypto";

import { env } from "../env.server";
import type { AgentId, RunContext } from "./types";

export interface TracePayload {
  agent: AgentId;
  traceId: string;
  model: string | null;
  promptVersion: string;
  mode: "deterministic" | "model";
  status: "success" | "retried" | "failed";
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error?: string | null;
}

export function tracingEnabled(): boolean {
  return Boolean(env.langfuse.publicKey && env.langfuse.secretKey);
}

export interface ToolTracePayload {
  agent: AgentId;
  traceId: string;
  tool: string;
  kind: "read" | "write";
  status: "ok" | "error";
  durationMs: number;
  errorCode?: string | null;
  replay?: boolean;
}

/** Tool spans carry names, durations and error codes only, never arguments or results. */
export async function traceTool(payload: ToolTracePayload): Promise<void> {
  if (!tracingEnabled()) return;
  const auth = Buffer.from(`${env.langfuse.publicKey}:${env.langfuse.secretKey}`).toString(
    "base64",
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    await fetch(`${env.langfuse.host}/api/public/ingestion`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
      body: JSON.stringify({
        batch: [
          {
            id: randomUUID(),
            type: "span-create",
            timestamp: new Date().toISOString(),
            body: {
              id: randomUUID(),
              traceId: payload.traceId,
              name: payload.tool,
              startTime: new Date(Date.now() - payload.durationMs).toISOString(),
              endTime: new Date().toISOString(),
              metadata: {
                agent: payload.agent,
                kind: payload.kind,
                status: payload.status,
                durationMs: payload.durationMs,
                errorCode: payload.errorCode ?? null,
                replayed: payload.replay ?? false,
              },
            },
          },
        ],
      }),
      signal: controller.signal,
    });
  } catch {
    // Tracing is best-effort and must never fail a tool call.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends identifiers and usage only. Prompt and completion bodies are never
 * sent, so document text cannot leak into the observability vendor.
 */
export async function traceRun(context: RunContext, payload: TracePayload): Promise<void> {
  if (!tracingEnabled()) return;
  const now = new Date();
  const start = new Date(now.getTime() - payload.latencyMs).toISOString();
  const generationId = randomUUID();
  const auth = Buffer.from(`${env.langfuse.publicKey}:${env.langfuse.secretKey}`).toString(
    "base64",
  );

  const batch = [
    {
      id: randomUUID(),
      type: "trace-create",
      timestamp: now.toISOString(),
      body: {
        id: payload.traceId,
        name: payload.agent,
        userId: context.userId,
        sessionId: context.chatId ?? undefined,
        metadata: {
          tenantId: context.tenantId,
          documentId: context.documentId,
          recordId: context.recordId,
          mode: payload.mode,
        },
      },
    },
    {
      id: randomUUID(),
      type: "generation-create",
      timestamp: now.toISOString(),
      body: {
        id: generationId,
        traceId: payload.traceId,
        name: payload.agent,
        model: payload.model ?? "deterministic",
        startTime: start,
        endTime: now.toISOString(),
        usage: { input: payload.inputTokens, output: payload.outputTokens },
        metadata: {
          promptVersion: payload.promptVersion,
          mode: payload.mode,
          status: payload.status,
          latencyMs: payload.latencyMs,
          costUsd: payload.costUsd,
          error: payload.error ?? null,
        },
      },
    },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    await fetch(`${env.langfuse.host}/api/public/ingestion`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
      body: JSON.stringify({ batch }),
      signal: controller.signal,
    });
  } catch {
    // Tracing is best-effort and must never fail a pipeline step.
  } finally {
    clearTimeout(timer);
  }
}
