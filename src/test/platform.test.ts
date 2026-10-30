import { describe, expect, it } from "vitest";

import type { JsonObject } from "@/lib/types";
import { mergePackConfig } from "@/server/packs.server";

describe("pack overrides", () => {
  it("merges nested config without dropping base keys", () => {
    const base = {
      catalogue: ["supplier_invoice", "purchase_order"],
      rules: { version: "2026-04", tolerance: 100 },
    };
    const patch = { rules: { tolerance: 250 } };

    expect(mergePackConfig(base, patch)).toEqual({
      catalogue: ["supplier_invoice", "purchase_order"],
      rules: { version: "2026-04", tolerance: 250 },
    });
  });

  it("replaces arrays instead of concatenating them", () => {
    const merged = mergePackConfig(
      { catalogue: ["supplier_invoice", "purchase_order"] },
      { catalogue: ["bank_statement"] },
    );
    expect(merged.catalogue).toEqual(["bank_statement"]);
  });

  it("ignores prototype keys", () => {
    const patch = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1}}') as JsonObject;
    const merged = mergePackConfig({ safe: true }, patch);
    expect(merged).toEqual({ safe: true });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});
