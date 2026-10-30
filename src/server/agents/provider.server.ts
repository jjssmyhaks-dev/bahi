import { env } from "../env.server";
import { AGENT_LIMITS } from "./config";

export class ModelError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "ModelError";
    this.status = status;
  }
}

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireMessage {
  role?: string;
  content?: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

interface ToolChatCompletion {
  choices?: { message?: WireMessage }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelToolCall {
  name: string;
  ok: boolean;
  summary: string;
}

export interface ModelToolReply {
  json: unknown;
  inputTokens: number;
  outputTokens: number;
  model: string;
  calls: ModelToolCall[];
}

export interface ModelReply {
  json: unknown;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/```$/, "")
    .trim();
}

/** Extracts the outermost JSON object without trusting anything else in the reply. */
export function parseJsonObject(text: string): unknown {
  const cleaned = stripCodeFence(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) throw new ModelError("The model did not return JSON.", 422);
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

async function requestOnce(input: {
  model: string;
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}): Promise<ModelReply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(`${env.ai.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        temperature: input.temperature,
        max_tokens: input.maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Never surface response bodies: they can echo document text.
      throw new ModelError(`The model provider returned ${response.status}.`, response.status);
    }

    const data = (await response.json()) as ChatCompletion;
    const content = data.choices?.[0]?.message?.content ?? "";
    if (!content.trim()) throw new ModelError("The model returned an empty reply.", 422);

    return {
      json: parseJsonObject(content),
      inputTokens: Number(data.usage?.prompt_tokens ?? 0),
      outputTokens: Number(data.usage?.completion_tokens ?? 0),
      model: data.model ?? input.model,
    };
  } catch (error) {
    if (error instanceof ModelError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ModelError("The model call timed out.", 408);
    }
    throw new ModelError("The model provider could not be reached.", 503);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One JSON-mode call with retries for network and provider availability errors.
 * Schema retries live in the runner, so a bad shape is never retried here.
 */
export async function callModelJson(input: {
  model: string;
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}): Promise<ModelReply> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < AGENT_LIMITS.networkAttempts; attempt++) {
    try {
      return await requestOnce(input);
    } catch (error) {
      lastError = error;
      const status = error instanceof ModelError ? error.status : 0;
      const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
      if (!retryable || attempt === AGENT_LIMITS.networkAttempts - 1) break;
      await sleep(300 * 3 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new ModelError("The model call failed.");
}

/**
 * Tool messages are read back as JSON by the model, so a trimmed payload stays
 * valid JSON and keeps the status fields; only the large result is collapsed.
 */
function trimForModel(value: unknown, limit = 8_000): string {
  const text = JSON.stringify(value ?? null) ?? "null";
  if (text.length <= limit) return text;
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const note = `The full tool result was ${text.length} characters and was trimmed. Use a narrower query to see more.`;
  const compact: Record<string, unknown> = {};
  for (const key of ["ok", "summary", "error"]) {
    if (key in record) compact[key] = record[key];
  }
  if ("ok" in compact) {
    compact["result"] = { truncated: true, note };
  } else {
    compact["message"] = note;
  }
  const compactText = JSON.stringify(compact);
  if (compactText.length <= limit) return compactText;
  return JSON.stringify({ ok: false, error: { code: "unavailable", message: note } });
}

/** One tool-enabled round. Content may be empty when the model asks for tools. */
async function requestToolRound(
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ message: WireMessage; inputTokens: number; outputTokens: number; model: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${env.ai.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.ai.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ModelError(`The model provider returned ${response.status}.`, response.status);
    }
    const data = (await response.json()) as ToolChatCompletion;
    const message = data.choices?.[0]?.message;
    if (!message) throw new ModelError("The model returned an empty reply.", 422);
    return {
      message,
      inputTokens: Number(data.usage?.prompt_tokens ?? 0),
      outputTokens: Number(data.usage?.completion_tokens ?? 0),
      model: data.model ?? String(body["model"] ?? ""),
    };
  } catch (error) {
    if (error instanceof ModelError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ModelError("The model call timed out.", 408);
    }
    throw new ModelError("The model provider could not be reached.", 503);
  } finally {
    clearTimeout(timer);
  }
}

async function requestToolRoundWithRetry(
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ message: WireMessage; inputTokens: number; outputTokens: number; model: string }> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < AGENT_LIMITS.networkAttempts; attempt++) {
    try {
      return await requestToolRound(body, timeoutMs);
    } catch (error) {
      lastError = error;
      const status = error instanceof ModelError ? error.status : 0;
      const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
      if (!retryable || attempt === AGENT_LIMITS.networkAttempts - 1) break;
      await sleep(300 * 3 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new ModelError("The model call failed.");
}

/**
 * Runs a bounded tool loop: the model may call registered tools, results are
 * sent back as tool messages, and the final message must be the typed JSON
 * answer. Unknown tools, bad arguments and limits become typed tool errors.
 */
export async function callModelWithTools(input: {
  model: string;
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  tools: ModelToolDefinition[];
  maxToolCalls: number;
  execute: (
    name: string,
    args: unknown,
  ) => Promise<{ ok: boolean; summary: string; result: unknown }>;
}): Promise<ModelToolReply> {
  const messages: Record<string, unknown>[] = [
    { role: "system", content: input.system },
    { role: "user", content: input.user },
  ];
  const calls: ModelToolCall[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let model = input.model;

  for (let round = 0; round <= input.maxToolCalls + 2; round++) {
    const reply = await requestToolRoundWithRetry(
      {
        model: input.model,
        temperature: input.temperature,
        max_tokens: input.maxTokens,
        messages,
        tools: input.tools.map((tool) => ({
          type: "function",
          function: tool,
        })),
        tool_choice: "auto",
      },
      input.timeoutMs,
    );
    inputTokens += reply.inputTokens;
    outputTokens += reply.outputTokens;
    model = reply.model || model;

    const requested = reply.message.tool_calls ?? [];
    if (!requested.length) {
      const content = reply.message.content ?? "";
      if (!content.trim()) throw new ModelError("The model returned an empty reply.", 422);
      return {
        json: parseJsonObject(content),
        inputTokens,
        outputTokens,
        model,
        calls,
      };
    }

    messages.push({
      role: "assistant",
      content: reply.message.content ?? null,
      tool_calls: requested,
    });

    let limited = false;
    for (const [index, call] of requested.entries()) {
      const name = call.function?.name ?? "";
      const id = call.id ?? `call_${round}_${index}`;

      if (calls.length >= input.maxToolCalls) {
        limited = true;
        messages.push({
          role: "tool",
          tool_call_id: id,
          content: trimForModel({
            ok: false,
            error: { code: "unavailable", message: "The tool call limit for this run is reached." },
          }),
        });
        continue;
      }

      let args: unknown = {};
      let parseFailed = false;
      try {
        const rawArguments = call.function?.arguments ?? "{}";
        args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
      } catch {
        parseFailed = true;
      }

      if (!name) {
        calls.push({
          name: "unknown",
          ok: false,
          summary: "The model called a tool without a name.",
        });
        messages.push({
          role: "tool",
          tool_call_id: id,
          content: trimForModel({
            ok: false,
            error: { code: "invalid_arguments", message: "The tool name was missing." },
          }),
        });
        continue;
      }

      if (parseFailed) {
        calls.push({ name, ok: false, summary: "The arguments were not valid JSON." });
        messages.push({
          role: "tool",
          tool_call_id: id,
          content: trimForModel({
            ok: false,
            error: { code: "invalid_arguments", message: "The arguments were not valid JSON." },
          }),
        });
        continue;
      }

      const outcome = await input.execute(name, args);
      calls.push({ name, ok: outcome.ok, summary: outcome.summary });
      messages.push({
        role: "tool",
        tool_call_id: id,
        content: trimForModel({
          ok: outcome.ok,
          summary: outcome.summary,
          ...(outcome.ok ? { result: outcome.result } : { error: outcome.result }),
        }),
      });
    }

    if (limited) throw new ModelError("The agent reached its tool call limit.", 422);
  }

  throw new ModelError("The agent kept calling tools without answering.", 422);
}

const PRICING_PER_MILLION: { match: RegExp; input: number; output: number }[] = [
  { match: /gpt-4o-mini/i, input: 0.15, output: 0.6 },
  { match: /gpt-4o/i, input: 2.5, output: 10 },
  { match: /gpt-4\.1-mini/i, input: 0.4, output: 1.6 },
  { match: /gpt-4\.1/i, input: 2, output: 8 },
];

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING_PER_MILLION.find((entry) => entry.match.test(model));
  if (!pricing) return 0;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}
