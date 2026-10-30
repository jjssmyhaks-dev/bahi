import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, mergeSettings } from "@/lib/settings";
import { FULL_ACCESS_CONFIRMATION, isPermissionLevel, PERMISSION_LEVELS } from "@/lib/permissions";
import { TOOL_CATALOGUE } from "@/server/agents/tools";
import { orchestratorPrompt } from "@/server/agents/prompts";
import type { RunContext } from "@/server/agents/types";
import { routeRecord, type RouteInput } from "@/server/router";

const pass = {
  id: "mandatory_fields",
  label: "Mandatory fields",
  outcome: "pass" as const,
  message: "All present.",
};

const warn = {
  id: "hsn_rate",
  label: "HSN rate",
  outcome: "warn" as const,
  message: "HSN rate is a guess.",
};

const fail = {
  id: "gstin_format",
  label: "GSTIN format",
  outcome: "fail" as const,
  message: "Bad GSTIN.",
};

function base(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    destination: "tally",
    overallConfidence: 0.99,
    rules: [pass],
    amountMinor: 100_000,
    settings: DEFAULT_SETTINGS,
    autonomyMode: "autonomous",
    autonomyStage: 3,
    shadowMode: false,
    killSwitch: false,
    postedToday: 0,
    permissionLevel: "auto",
    ...overrides,
  };
}

describe("permission levels", () => {
  it("defaults to Auto approve and only accepts the three levels", () => {
    expect(DEFAULT_SETTINGS.permissions).toEqual({ level: "auto", ceilingMinor: 0 });
    expect(PERMISSION_LEVELS).toEqual(["ask", "auto", "full"]);
    expect(isPermissionLevel("ask")).toBe(true);
    expect(isPermissionLevel("auto")).toBe(true);
    expect(isPermissionLevel("full")).toBe(true);
    expect(isPermissionLevel("everyone")).toBe(false);
    expect(mergeSettings({}).permissions.level).toBe("auto");
    expect(mergeSettings({ permissions: { level: "bogus" } }).permissions.level).toBe("auto");
    expect(FULL_ACCESS_CONFIRMATION).toBe("FULL ACCESS");
  });

  it("Ask every time never writes on its own, even for a clean record", () => {
    const decision = routeRecord(base({ permissionLevel: "ask" }));
    expect(decision.action).toBe("review");
    expect(decision.wouldPost).toBe(false);
    expect(decision.reasons.join(" ")).toContain("Ask every time");
  });

  it("reads the level captured at run start, not the current autonomy mode", () => {
    const asAsk = routeRecord(
      base({ permissionLevel: "ask", autonomyMode: "autonomous", autonomyStage: 4 }),
    );
    const asFull = routeRecord(base({ permissionLevel: "full", autonomyMode: "draft" }));
    expect(asAsk.action).toBe("review");
    expect(asFull.action).toBe("auto_post");
  });

  it("Auto approve posts a clean record and asks on each risk condition", () => {
    expect(routeRecord(base({ permissionLevel: "auto" })).action).toBe("auto_post");

    const risks: [Partial<RouteInput>, string][] = [
      [{ overallConfidence: 0.4 }, "confidence"],
      [{ rules: [warn] }, "HSN"],
      [{ amountMinor: 50_000_000 }, "auto-post limit"],
      [{ mappingConfirmed: false }, "column mapping"],
      [{ destinationHealthy: false }, "not reachable"],
      [{ documentQuality: "suspect" }, "hard to read"],
      [{ killSwitch: true }, "kill switch"],
      [{ postedToday: DEFAULT_SETTINGS.limits.dailyPostCap }, "daily"],
      [{ overallConfidence: 0.99, amountMinor: 20_000_000 }, "ceiling"],
    ];

    for (const [patch, hint] of risks) {
      const decision = routeRecord(
        base({
          permissionLevel: "auto",
          ...(hint === "ceiling" ? { ceilingMinor: 10_000_000 } : {}),
          ...patch,
        }),
      );
      expect(decision.action, hint).toBe("review");
      expect(decision.reasons.join(" ").toLowerCase(), hint).toContain(hint.toLowerCase());
    }
  });

  it("Full access skips confidence, warnings, stage and shadow but keeps hard stops", () => {
    const cleanFull = routeRecord(
      base({
        permissionLevel: "full",
        overallConfidence: 0.2,
        rules: [warn],
        autonomyStage: 0,
        shadowMode: true,
      }),
    );
    expect(cleanFull.action).toBe("auto_post");
    expect(cleanFull.shadow).toBe(false);

    expect(routeRecord(base({ permissionLevel: "full", rules: [fail] })).action).toBe("review");
    expect(routeRecord(base({ permissionLevel: "full", killSwitch: true })).action).toBe("review");
    expect(routeRecord(base({ permissionLevel: "full", ceilingMinor: 50_000 })).action).toBe(
      "review",
    );
    expect(
      routeRecord(
        base({
          permissionLevel: "full",
          postedToday: DEFAULT_SETTINGS.limits.dailyPostCap,
        }),
      ).action,
    ).toBe("review");
  });

  it("no tool can change the permission level", () => {
    const names = Object.values(TOOL_CATALOGUE).flatMap((tools) => tools.map((tool) => tool.name));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).not.toMatch(/permission/i);
    }
    expect(names).not.toContain("set_autonomy");
    expect(names).not.toContain("update_settings");
  });

  it("tells the Chat Orchestrator the run's level", () => {
    const context: RunContext = {
      tenantId: "11111111-1111-1111-1111-111111111111",
      userId: "22222222-2222-2222-2222-222222222222",
      schema: "bahi_t_test",
      chatId: null,
      documentId: null,
      recordId: null,
      role: "owner",
      autonomyMode: "autonomous",
      permissionLevel: "full",
      killSwitch: false,
      settings: DEFAULT_SETTINGS,
      pack: { key: "manufacturing", version: "1.0.0" },
      traceId: "test-trace",
    };
    const prompt = orchestratorPrompt(context, {
      message: "what is on?",
      pending: [],
      documents: [],
    });
    expect(prompt.system).toContain("Full access (full)");
    expect(prompt.system).toContain("You cannot change it");
  });
});
