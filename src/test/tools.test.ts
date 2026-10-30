import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DEFAULT_SETTINGS } from "@/lib/settings";
import type { RecordRow, SessionUser } from "@/lib/types";
import { AGENT_IDS, type RunContext } from "@/server/agents/types";
import { TOOL_CATALOGUE, TOOL_NAMES_BY_AGENT, validateToolCatalogue } from "@/server/agents/tools";
import { defineTool, ok } from "@/server/agents/tools/types";
import { executeTool } from "@/server/agents/tools/executor";
import { approveRecordsTool, resolveTargetIds } from "@/server/agents/tools/orchestrator";
import { checkApprovalRights } from "@/server/agents/tools/access";

const savedCalls: {
  tool: string;
  summary: string | null;
  result: unknown;
  idempotencyKey: string | null;
}[] = [];

vi.mock("@/server/agents/tools/store.server", () => ({
  findToolCall: async (_schema: string, tool: string, key: string) => {
    const found = savedCalls.find((call) => call.tool === tool && call.idempotencyKey === key);
    return found
      ? {
          id: "call-1",
          agent: "chat_orchestrator",
          tool,
          kind: "write",
          status: "ok",
          summary: found.summary,
          errorCode: null,
          idempotencyKey: key,
          durationMs: 1,
          result: found.result,
          createdAt: new Date().toISOString(),
        }
      : null;
  },
  insertToolCall: async (
    _run: RunContext,
    input: {
      tool: string;
      status: string;
      summary: string | null;
      result?: unknown;
      idempotencyKey?: string | null;
    },
  ) => {
    if (input.status === "ok" && input.idempotencyKey) {
      savedCalls.push({
        tool: input.tool,
        summary: input.summary,
        result: input.result ?? null,
        idempotencyKey: input.idempotencyKey,
      });
    }
  },
  toolCallTotals: async () => ({ calls: 0, writes: 0, failures: 0 }),
}));

vi.mock("@/server/agents/tracing.server", () => ({
  traceTool: async () => undefined,
  tracingEnabled: () => false,
  traceRun: async () => undefined,
}));

function context(overrides: Partial<RunContext> = {}): RunContext {
  return {
    tenantId: "11111111-1111-1111-1111-111111111111",
    userId: "22222222-2222-2222-2222-222222222222",
    schema: "bahi_t_test",
    chatId: null,
    documentId: null,
    recordId: null,
    role: "owner",
    autonomyMode: "autonomous",
    permissionLevel: "auto",
    killSwitch: false,
    settings: DEFAULT_SETTINGS,
    pack: { key: "manufacturing", version: "1.0.0" },
    traceId: "test-trace",
    ...overrides,
  };
}

function session(role: SessionUser["role"]): SessionUser {
  return {
    userId: "22222222-2222-2222-2222-222222222222",
    tenantId: "11111111-1111-1111-1111-111111111111",
    tenantName: "Test Co",
    tenantSlug: "test-co",
    role,
    name: "Test User",
    email: "test@example.com",
    schema: "bahi_t_test",
    autonomyMode: "autonomous",
    autonomyStage: 1,
    shadowMode: true,
    killSwitch: false,
    retentionDays: 365,
    errorBudgetPct: 0.5,
    permissionLevel: "auto",
    settings: DEFAULT_SETTINGS,
  };
}

function record(amountMinor: number, title = "Invoice"): RecordRow {
  return {
    id: "33333333-3333-3333-3333-333333333333",
    chatId: null,
    documentId: null,
    docType: "supplier_invoice",
    title,
    fields: { vendor_name: "Deccan Steel" },
    confidences: {},
    validation: [],
    overallConfidence: 0.9,
    status: "pending_review",
    destination: "tally",
    destinationRef: null,
    destinationNote: null,
    reason: null,
    priority: 50,
    amountMinor,
    idempotencyKey: "key",
    groupKey: null,
    assignedTo: null,
    assignedToName: null,
    dueAt: null,
    reviewReason: null,
    locations: {},
    evidence: {},
    shadow: false,
    sourceChannel: "chat",
    postedAt: null,
    reviewedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    envelope: {},
    agentMode: "deterministic",
    permissionLevel: null,
    approvedPermissionLevel: null,
    document: null,
  };
}

describe("tool catalogue", () => {
  it("registers exactly the tools the specification allows", () => {
    expect(validateToolCatalogue()).toEqual([]);

    for (const agent of AGENT_IDS) {
      expect(TOOL_CATALOGUE[agent].map((tool) => tool.name)).toEqual([
        ...TOOL_NAMES_BY_AGENT[agent],
      ]);
    }
    expect(TOOL_CATALOGUE.chat_orchestrator).toHaveLength(16);
    expect(TOOL_CATALOGUE.document_classifier).toHaveLength(2);
    expect(TOOL_CATALOGUE.extraction).toHaveLength(4);
    expect(TOOL_CATALOGUE.master_matcher).toHaveLength(6);
    expect(TOOL_CATALOGUE.validation_explainer).toHaveLength(0);
    expect(TOOL_CATALOGUE.destination_mapper).toHaveLength(3);
    expect(TOOL_CATALOGUE.bank_categoriser).toHaveLength(4);
    expect(TOOL_CATALOGUE.learning_curator).toHaveLength(2);
  });

  it("rejects tenant and user identifiers on every tool", async () => {
    const tools = new Map<string, (typeof TOOL_CATALOGUE)[keyof typeof TOOL_CATALOGUE][number]>();
    for (const list of Object.values(TOOL_CATALOGUE)) {
      for (const tool of list) tools.set(tool.name, tool);
    }

    for (const tool of tools.values()) {
      const result = await tool.run(
        { tenant_id: "other", user_id: "other" },
        { run: context(), session: session("owner") },
      );
      expect(result.ok, tool.name).toBe(false);
      if (!result.ok) expect(result.error.code, tool.name).toBe("invalid_arguments");
    }
  });

  it("keeps identity out of every JSON schema", () => {
    for (const list of Object.values(TOOL_CATALOGUE)) {
      for (const tool of list) {
        const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties;
        expect(properties?.["tenant_id"], tool.name).toBeUndefined();
        expect(properties?.["user_id"], tool.name).toBeUndefined();
        expect(properties?.["schema"], tool.name).toBeUndefined();
      }
    }
  });
});

describe("tool permissions and ambiguity", () => {
  it("blocks a viewer before touching a record", async () => {
    const result = await approveRecordsTool.run(
      { record_ids: ["33333333-3333-3333-3333-333333333333"] },
      { run: context({ role: "viewer" }), session: session("viewer") },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_permitted");
  });

  it("blocks a reviewer above the approval limit", () => {
    const reviewer = session("reviewer");
    const result = checkApprovalRights(
      reviewer,
      record(reviewer.settings.limits.autoPostValueMinor + 1_000),
    );
    if (!("ok" in result)) {
      throw new Error("expected the approval to be blocked");
    }
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("not_permitted");
    expect(result.error.message).toContain("approval limit");
  });

  it("returns an ambiguity result for a multi-record action without group approval", () => {
    const result = resolveTargetIds(["a", "b"], false, [
      record(1000, "Invoice A"),
      record(2000, "Invoice B"),
    ]);
    expect(result?.error.code).toBe("ambiguous");
    expect(result?.error.candidates).toHaveLength(2);
  });
});

describe("write tool idempotency", () => {
  beforeEach(() => {
    savedCalls.length = 0;
  });

  it("replays a successful write with the same key", async () => {
    let executions = 0;
    const tool = defineTool({
      name: "test_write",
      description: "test",
      kind: "write",
      agents: ["chat_orchestrator"],
      schema: z.object({
        value: z.string(),
        idempotency_key: z.string().optional(),
      }),
      run: async () => {
        executions += 1;
        return ok({ executions }, "wrote once");
      },
    });

    const first = await executeTool({
      tool,
      agent: "chat_orchestrator",
      args: { value: "a", idempotency_key: "same-key" },
      run: context(),
      session: session("owner"),
    });
    const second = await executeTool({
      tool,
      agent: "chat_orchestrator",
      args: { value: "a", idempotency_key: "same-key" },
      run: context(),
      session: session("owner"),
    });

    expect(first.result.ok).toBe(true);
    expect(executions).toBe(1);
    expect(second.chip.replayed).toBe(true);
    expect(second.result.ok && second.result.idempotentReplay).toBe(true);
  });

  it("refuses a write without an idempotency key", async () => {
    let executions = 0;
    const tool = defineTool({
      name: "test_write_without_key",
      description: "test",
      kind: "write",
      agents: ["chat_orchestrator"],
      schema: z.object({ value: z.string() }),
      run: async () => {
        executions += 1;
        return ok({}, "wrote");
      },
    });

    const result = await executeTool({
      tool,
      agent: "chat_orchestrator",
      args: { value: "a" },
      run: context(),
      session: session("owner"),
    });

    expect(result.result.ok).toBe(false);
    if (!result.result.ok) expect(result.result.error.code).toBe("invalid_arguments");
    expect(executions).toBe(0);
  });
});
