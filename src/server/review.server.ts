import type { Destination, ReviewRequestRow, SessionUser } from "@/lib/types";
import { sql, sqlOne, table } from "./db.server";
import { approveRecord, holdRecord, rejectRecord } from "./pipeline.server";

export interface WorkspaceMember {
  id: string;
  name: string;
  email: string;
  role: "owner" | "reviewer" | "viewer";
}

export interface ReviewRequestView extends ReviewRequestRow {
  requestedByName: string | null;
  answeredByName: string | null;
}

function assertWriter(session: SessionUser): void {
  if (session.role === "viewer") {
    throw new Error("Your role cannot change records.");
  }
}

export async function listMembers(session: SessionUser): Promise<WorkspaceMember[]> {
  const rows = await sql<{ id: string; name: string | null; email: string; role: string }>(
    `select u.id, u.name, u.email, m.role
       from bahi.memberships m
       join bahi.users u on u.id = m.user_id
      where m.tenant_id = $1
      order by case m.role when 'owner' then 0 when 'reviewer' then 1 else 2 end, u.name nulls last`,
    [session.tenantId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name ?? row.email,
    email: row.email,
    role: row.role as WorkspaceMember["role"],
  }));
}

export interface AssignInput {
  recordId: string;
  userId: string | null;
  dueAt: string | null;
}

export async function assignRecord(session: SessionUser, input: AssignInput): Promise<void> {
  assertWriter(session);
  const record = await sqlOne<{ id: string }>(
    `select id from ${table(session.schema, "records")} where id = $1`,
    [input.recordId],
  );
  if (!record) throw new Error("Record not found.");

  let assignee: { name: string | null; email: string } | null = null;
  if (input.userId) {
    assignee = await sqlOne<{ name: string | null; email: string }>(
      `select u.name, u.email
         from bahi.memberships m join bahi.users u on u.id = m.user_id
        where m.tenant_id = $1 and m.user_id = $2`,
      [session.tenantId, input.userId],
    );
    if (!assignee) throw new Error("That person is not a member of this workspace.");
  }

  let dueAt: string | null = null;
  if (input.dueAt) {
    const parsed = new Date(input.dueAt);
    if (Number.isNaN(parsed.getTime())) throw new Error("That due date could not be read.");
    dueAt = parsed.toISOString();
  }

  await sql(
    `update ${table(session.schema, "records")}
        set assigned_to = $2::uuid, due_at = $3::timestamptz, updated_at = now()
      where id = $1`,
    [input.recordId, input.userId, dueAt],
  );
  await sql(
    `insert into ${table(session.schema, "activity")} (user_id, record_id, action, detail)
     values ($1, $2, 'record.assigned', $3::jsonb)`,
    [
      session.userId,
      input.recordId,
      JSON.stringify({
        assignedTo: input.userId,
        assignedToName: assignee?.name ?? assignee?.email ?? null,
        dueAt,
      }),
    ],
  );
}

export interface RequestInput {
  recordId: string;
  kind: "document" | "clarification";
  message: string;
}

export async function requestReviewInput(
  session: SessionUser,
  input: RequestInput,
): Promise<ReviewRequestView> {
  assertWriter(session);
  const message = input.message.trim();
  if (!message) throw new Error("Write what you need from the person first.");

  const row = await sqlOne<Record<string, unknown>>(
    `insert into ${table(session.schema, "review_requests")}
       (record_id, kind, message, requested_by)
     values ($1, $2, $3, $4) returning *`,
    [input.recordId, input.kind, message, session.userId],
  );
  if (!row) throw new Error("The request could not be recorded.");

  await sql(
    `update ${table(session.schema, "records")}
        set status = 'held', review_reason = $2, updated_at = now()
      where id = $1 and status in ('pending_review','held')`,
    [input.recordId, message],
  );
  await sql(
    `insert into ${table(session.schema, "activity")} (user_id, record_id, action, detail)
     values ($1, $2, 'review.requested', $3::jsonb)`,
    [session.userId, input.recordId, JSON.stringify({ kind: input.kind, message })],
  );

  return reviewRequestFrom(row, session.name, null);
}

function reviewRequestFrom(
  row: Record<string, unknown>,
  requestedByName: string | null,
  answeredByName: string | null,
): ReviewRequestView {
  return {
    id: String(row["id"]),
    recordId: String(row["record_id"]),
    kind: row["kind"] as ReviewRequestView["kind"],
    message: String(row["message"]),
    status: row["status"] as ReviewRequestView["status"],
    requestedBy: row["requested_by"] ? String(row["requested_by"]) : null,
    answeredBy: row["answered_by"] ? String(row["answered_by"]) : null,
    answer: row["answer"] ? String(row["answer"]) : null,
    createdAt: new Date(String(row["created_at"])).toISOString(),
    answeredAt: row["answered_at"] ? new Date(String(row["answered_at"])).toISOString() : null,
    requestedByName,
    answeredByName,
  };
}

export async function listReviewRequests(
  schema: string,
  recordId: string,
): Promise<ReviewRequestView[]> {
  const rows = await sql<Record<string, unknown>>(
    `select rr.*, requester.name as requester_name, answerer.name as answerer_name
       from ${table(schema, "review_requests")} rr
       left join bahi.users requester on requester.id = rr.requested_by
       left join bahi.users answerer on answerer.id = rr.answered_by
      where rr.record_id = $1
      order by rr.created_at desc`,
    [recordId],
  );
  return rows.map((row) =>
    reviewRequestFrom(
      row,
      row["requester_name"] ? String(row["requester_name"]) : null,
      row["answerer_name"] ? String(row["answerer_name"]) : null,
    ),
  );
}

export async function answerReviewRequest(
  session: SessionUser,
  requestId: string,
  answer: string,
): Promise<ReviewRequestView> {
  assertWriter(session);
  const clean = answer.trim();
  if (!clean) throw new Error("Write an answer first.");

  const row = await sqlOne<Record<string, unknown>>(
    `update ${table(session.schema, "review_requests")}
        set status = 'answered', answer = $2, answered_by = $3, answered_at = now()
      where id = $1 and status = 'open' returning *`,
    [requestId, clean, session.userId],
  );
  if (!row) throw new Error("That request is already answered or no longer open.");

  await sql(
    `update ${table(session.schema, "records")}
        set status = 'pending_review', review_reason = null, updated_at = now()
      where id = $1 and status = 'held'`,
    [String(row["record_id"])],
  );
  await sql(
    `insert into ${table(session.schema, "activity")} (user_id, record_id, action, detail)
     values ($1, $2, 'review.answered', $3::jsonb)`,
    [session.userId, String(row["record_id"]), JSON.stringify({ requestId, answer: clean })],
  );
  return reviewRequestFrom(row, null, session.name);
}

export interface BulkActionInput {
  recordIds: string[];
  action: "approve" | "reject" | "hold";
  destination?: Destination;
  reason?: string;
}

export interface BulkActionResult {
  succeeded: string[];
  failed: { recordId: string; message: string }[];
}

export async function bulkRecordAction(
  session: SessionUser,
  input: BulkActionInput,
): Promise<BulkActionResult> {
  assertWriter(session);
  const ids = [...new Set(input.recordIds)].slice(0, 25);
  const succeeded: string[] = [];
  const failed: { recordId: string; message: string }[] = [];

  for (const recordId of ids) {
    try {
      if (input.action === "approve") {
        await approveRecord(session, recordId, {
          ...(input.destination ? { destination: input.destination } : {}),
          ...(input.reason ? { note: input.reason } : {}),
        });
      } else if (input.action === "reject") {
        await rejectRecord(
          session,
          recordId,
          input.reason ?? "Rejected in bulk from the review queue.",
        );
      } else {
        await holdRecord(session, recordId, input.reason ?? "Held in bulk from the review queue.");
      }
      succeeded.push(recordId);
    } catch (error) {
      failed.push({
        recordId,
        message: error instanceof Error ? error.message : "That record could not be updated.",
      });
    }
  }

  await sql(
    `insert into ${table(session.schema, "activity")} (user_id, action, detail)
     values ($1, 'review.bulk', $2::jsonb)`,
    [
      session.userId,
      JSON.stringify({
        action: input.action,
        requested: ids.length,
        succeeded: succeeded.length,
        failed: failed.length,
        destination: input.destination ?? null,
      }),
    ],
  );

  return { succeeded, failed };
}
