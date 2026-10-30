import type { RecordRow, SessionUser } from "@/lib/types";
import { formatINR } from "@/lib/format";
import { getRecord } from "../../repo.server";
import { fail, type ToolFailure } from "./types";

export function requireSession(session: SessionUser | null): SessionUser | ToolFailure {
  if (!session) {
    return fail("not_permitted", "This action needs a signed-in person.");
  }
  return session;
}

/** Viewers can read; reviewers and owners can write. */
export function requireWriter(
  session: SessionUser | null,
  action = "change records",
): SessionUser | ToolFailure {
  const current = requireSession(session);
  if ("ok" in current) return current;
  if (current.role === "viewer") {
    return fail("not_permitted", `Your role cannot ${action}. Ask an owner or reviewer.`);
  }
  return current;
}

export function requireOwner(
  session: SessionUser | null,
  action = "change this",
): SessionUser | ToolFailure {
  const current = requireSession(session);
  if ("ok" in current) return current;
  if (current.role !== "owner") {
    return fail("not_permitted", `Only an owner can ${action}.`);
  }
  return current;
}

/**
 * A reviewer may approve ordinary records; anything above the tenant's
 * auto-post value limit needs an owner. Owners have no amount ceiling.
 */
export function checkApprovalRights(
  session: SessionUser | null,
  record: RecordRow,
): SessionUser | ToolFailure {
  const current = requireWriter(session, "approve records");
  if ("ok" in current) return current;
  if (
    current.role === "reviewer" &&
    record.amountMinor > current.settings.limits.autoPostValueMinor
  ) {
    return fail(
      "not_permitted",
      `This record is ${formatINR(record.amountMinor)}, above your ${formatINR(
        current.settings.limits.autoPostValueMinor,
      )} approval limit. Ask an owner to approve it.`,
    );
  }
  return current;
}

export async function loadRecord(
  schema: string,
  recordId: string,
): Promise<RecordRow | ToolFailure> {
  const record = await getRecord(schema, recordId);
  if (!record) return fail("not_found", "That record is not in this workspace.");
  return record;
}

export function isOpen(record: RecordRow): boolean {
  return record.status === "pending_review" || record.status === "held";
}

export function recordSummary(record: RecordRow) {
  return {
    id: record.id,
    title: record.title,
    docType: record.docType,
    status: record.status,
    amountMinor: record.amountMinor,
    destination: record.destination,
    overallConfidence: record.overallConfidence,
  };
}
