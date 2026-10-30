import { z } from "zod";

import type { SessionUser } from "@/lib/types";
import type { AgentId, RunContext } from "../types";

export type ToolKind = "read" | "write";

export type ToolErrorCode =
  | "invalid_arguments"
  | "not_found"
  | "not_permitted"
  | "ambiguous"
  | "conflict"
  | "destination_error"
  | "unavailable"
  | "internal";

export interface ToolErrorBody {
  code: ToolErrorCode;
  message: string;
  candidates?: { id: string; label: string }[] | undefined;
}

export interface ToolSuccess<T> {
  ok: true;
  result: T;
  summary: string;
  idempotentReplay?: boolean | undefined;
}

export interface ToolFailure {
  ok: false;
  error: ToolErrorBody;
}

export type ToolResult<T = unknown> = ToolSuccess<T> | ToolFailure;

/**
 * Tools only reach tenant data through this context. Tenant and user ids are
 * injected by the server; no tool schema accepts them as arguments.
 */
export interface ToolContext {
  run: RunContext;
  session: SessionUser | null;
}

export interface ToolDefinition {
  name: string;
  description: string;
  kind: ToolKind;
  /** Agents that may call this tool. Nothing outside this list is registered. */
  agents: readonly AgentId[];
  /** JSON schema shown to the model, generated from the Zod schema. */
  parameters: Record<string, unknown>;
  schema: z.ZodTypeAny;
  run: (rawArgs: unknown, context: ToolContext) => Promise<ToolResult>;
}

export function ok<T>(result: T, summary: string): ToolSuccess<T> {
  return { ok: true, result, summary };
}

export function fail(
  code: ToolErrorCode,
  message: string,
  candidates?: { id: string; label: string }[],
): ToolFailure {
  return { ok: false, error: { code, message, ...(candidates ? { candidates } : {}) } };
}

export function defineTool<Args>(input: {
  name: string;
  description: string;
  kind: ToolKind;
  agents: readonly AgentId[];
  schema: z.ZodType<Args>;
  run: (args: Args, context: ToolContext) => Promise<ToolResult<unknown>>;
}): ToolDefinition {
  return {
    name: input.name,
    description: input.description,
    kind: input.kind,
    agents: input.agents,
    parameters: zodToJsonSchema(input.schema),
    schema: input.schema,
    run: async (raw, context) => {
      const injected = assertNoInjectedIdentity(raw);
      if (injected) return injected;
      const parsed = input.schema.safeParse(raw ?? {});
      if (!parsed.success) {
        return fail(
          "invalid_arguments",
          `The arguments did not match the tool schema: ${parsed.error.issues
            .slice(0, 4)
            .map((issue) => `${issue.path.join(".") || "args"}: ${issue.code}`)
            .join("; ")}`,
        );
      }
      try {
        return await input.run(parsed.data, context);
      } catch (error) {
        return fail(
          "internal",
          error instanceof Error ? error.message.slice(0, 300) : "The tool failed.",
        );
      }
    },
  };
}

/**
 * Converts the small Zod subset used by the tool schemas into JSON Schema. It is
 * deliberately generic: unknown node types fall back to a permissive object.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as { typeName?: string } & Record<string, unknown>;
  const typeName = def.typeName;

  if (typeName === "ZodObject") {
    const shape = (schema as unknown as z.ZodObject<z.ZodRawShape>).shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      if (!value.isOptional()) required.push(key);
    }
    return {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    };
  }
  if (typeName === "ZodString") {
    const checks = (def.checks as { kind: string; value?: number }[] | undefined) ?? [];
    const min = checks.find((check) => check.kind === "min")?.value;
    const max = checks.find((check) => check.kind === "max")?.value;
    return {
      type: "string",
      ...(min !== undefined ? { minLength: min } : {}),
      ...(max !== undefined ? { maxLength: max } : {}),
    };
  }
  if (typeName === "ZodNumber") {
    const checks = (def.checks as { kind: string; value?: number }[] | undefined) ?? [];
    const min = checks.find((check) => check.kind === "min")?.value;
    const max = checks.find((check) => check.kind === "max")?.value;
    const integral = checks.some((check) => check.kind === "int");
    return {
      type: integral ? "integer" : "number",
      ...(min !== undefined ? { minimum: min } : {}),
      ...(max !== undefined ? { maximum: max } : {}),
    };
  }
  if (typeName === "ZodBoolean") return { type: "boolean" };
  if (typeName === "ZodEnum") {
    return { type: "string", enum: def.values as string[] };
  }
  if (typeName === "ZodLiteral") return { const: def.value };
  if (typeName === "ZodArray") {
    return {
      type: "array",
      items: zodToJsonSchema(def.type as z.ZodTypeAny),
      ...(typeof def.minLength === "number" ? { minItems: def.minLength } : {}),
      ...(typeof def.maxLength === "number" ? { maxItems: def.maxLength } : {}),
    };
  }
  if (typeName === "ZodOptional" || typeName === "ZodNullable" || typeName === "ZodDefault") {
    const inner = zodToJsonSchema(def.innerType as z.ZodTypeAny);
    return typeName === "ZodNullable" ? { ...inner, nullable: true } : inner;
  }
  if (typeName === "ZodEffects") {
    return zodToJsonSchema(def.schema as z.ZodTypeAny);
  }
  if (typeName === "ZodRecord") {
    return {
      type: "object",
      additionalProperties: zodToJsonSchema(def.valueType as z.ZodTypeAny),
    };
  }
  if (typeName === "ZodUnion") {
    return {
      anyOf: (def.options as z.ZodTypeAny[]).map((option) => zodToJsonSchema(option)),
    };
  }
  return { type: "object", additionalProperties: true };
}

/** Explicitly rejects tenant or user identifiers supplied by the model. */
export function assertNoInjectedIdentity(raw: unknown): ToolFailure | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const forbidden = ["tenant_id", "tenantId", "user_id", "userId", "schema", "schema_name"];
  const found = forbidden.filter((key) => key in (raw as Record<string, unknown>));
  if (!found.length) return null;
  return fail(
    "invalid_arguments",
    `Tenant and user identifiers are injected by the server, not passed to tools (${found.join(", ")}).`,
  );
}
