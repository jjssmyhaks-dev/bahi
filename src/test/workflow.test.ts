import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  WORKFLOW_FUNCTIONS,
  checkFile,
  hashFile,
  lookupGstin,
  normaliseRecord,
  rollbackWrite,
  scanFile,
  sendNotification,
} from "@/server/workflow.server";
import type { SessionUser } from "@/lib/types";
import { DEFAULT_SETTINGS } from "@/lib/settings";

const file = (name: string, content: string, mimeType = "application/pdf") => ({
  name,
  mimeType,
  base64: Buffer.from(content).toString("base64"),
});

describe("workflow function names", () => {
  it("matches the specification list exactly", () => {
    expect(Object.keys(WORKFLOW_FUNCTIONS)).toEqual([
      "store_upload",
      "check_file",
      "scan_file",
      "hash_file",
      "check_duplicate_by_hash",
      "split_pdf_pages",
      "run_classifier",
      "run_extraction",
      "normalise_record",
      "run_master_matching",
      "run_bank_categoriser",
      "run_validation_rules",
      "run_validation_explainer",
      "check_duplicate_by_content",
      "route_record",
      "create_review_item",
      "wait_for_approval",
      "lookup_gstin",
      "refresh_master_data",
      "map_to_destination",
      "build_tally_voucher",
      "queue_bridge_command",
      "write_to_excel",
      "write_to_google_sheet",
      "confirm_write",
      "rollback_write",
      "check_approval_rights",
      "record_approval",
      "store_confirmed_mapping",
      "save_correction",
      "embed_document",
      "run_learning_curator",
      "activate_rule",
      "push_chat_event",
      "send_notification",
      "write_audit_entry",
      "record_usage",
    ]);
  });
});

describe("workflow helpers", () => {
  it("checks file type and size", () => {
    const unsupported = checkFile(file("bill.exe", "MZ", "application/octet-stream"));
    expect(unsupported.ok && unsupported.data.problems.join(" ")).toContain("not supported");

    const empty = checkFile(file("bill.pdf", ""));
    expect(empty.ok && empty.data.problems.join(" ")).toContain("empty");
  });

  it("hashes file bytes", () => {
    const result = hashFile(file("bill.pdf", "abc"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.sha256).toBe(createHash("sha256").update("abc").digest("hex"));
      expect(result.data.sizeBytes).toBe(3);
    }
  });

  it("normalises money, GSTIN and dates without guessing", () => {
    const result = normaliseRecord({
      total: "₹1,23,456.00",
      vendor_gstin: " 27 aac cp9876 d1z1 ",
      invoice_date: "22/10/2026",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.total).toBe(123456);
      expect(result.data.vendor_gstin).toBe("27AACCP9876D1Z1");
      expect(result.data.invoice_date).toBe("2026-10-22");
    }
  });

  it("reports unavailable integrations honestly", async () => {
    expect(scanFile(file("bill.pdf", "abc")).ok).toBe(false);
    expect((await rollbackWrite(session(), "record", "tally")).ok).toBe(false);
    expect(sendNotification(session(), "email", "a@b.com", "hi").ok).toBe(false);
    const gstin = await lookupGstin("27AACCP9876D1Z1");
    expect(gstin.ok && gstin.data.verified).toBe(false);
  });
});

function session(): SessionUser {
  return {
    userId: "22222222-2222-2222-2222-222222222222",
    tenantId: "11111111-1111-1111-1111-111111111111",
    tenantName: "Test Co",
    tenantSlug: "test-co",
    role: "owner",
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
