import { describe, expect, it } from "vitest";

import {
  BRIDGE_COMMAND_TYPES,
  buildBridgeCommand,
  queueBridgeCommand,
} from "@/server/bridge.server";

describe("bridge commands", () => {
  it("shapes every command type the specification lists", () => {
    const samples: Record<(typeof BRIDGE_COMMAND_TYPES)[number], Record<string, unknown>> = {
      ping: {},
      sync_masters: { page: 1, pageSize: 50 },
      post_voucher: { voucher: { voucherNumber: "V-1" } },
      post_voucher_draft: { voucher: { voucherNumber: "V-2" } },
      get_voucher_status: { idempotencyKey: "post-1" },
      cancel_voucher: { voucherNumber: "V-1", reason: "duplicate" },
      get_company_info: {},
    };
    for (const type of BRIDGE_COMMAND_TYPES) {
      const built = buildBridgeCommand({
        type,
        idempotencyKey: `key-${type}`,
        payload: samples[type],
      });
      expect(built.ok, type).toBe(true);
      if (built.ok) expect(built.command.type).toBe(type);
    }
  });

  it("rejects a command without its required payload", () => {
    const built = buildBridgeCommand({ type: "post_voucher", idempotencyKey: "key" });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.message).toContain("voucher");
  });

  it("requires an idempotency key", () => {
    const built = buildBridgeCommand({ type: "ping", idempotencyKey: "  " });
    expect(built.ok).toBe(false);
  });

  it("never claims a queue accepted the command", () => {
    const result = queueBridgeCommand({ type: "ping", idempotencyKey: "ping-1" });
    expect(result.queued).toBe(false);
    expect(result.message).toContain("No Tally bridge agent");
  });
});
