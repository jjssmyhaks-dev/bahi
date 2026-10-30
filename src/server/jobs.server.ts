import { adminClient, sessionForTenant } from "./auth.server";
import { env } from "./env.server";
import { sql, sqlOne, table } from "./db.server";
import { processIntakeJob } from "./intake.server";

export const JOB_KINDS = ["retention.purge", "intake.process", "notifications.digest"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface JobRow {
  id: string;
  tenantId: string | null;
  kind: string;
  status: "queued" | "running" | "done" | "failed";
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  runAfter: string;
  createdAt: string;
}

interface RawJob {
  id: string;
  tenant_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  status: JobRow["status"];
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  run_after: Date;
  created_at: Date;
}

function toJob(row: RawJob): JobRow {
  return {
    id: String(row.id),
    tenantId: row.tenant_id,
    kind: row.kind,
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    lastError: row.last_error,
    runAfter: new Date(row.run_after).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function enqueueJob(input: {
  tenantId: string | null;
  kind: JobKind;
  payload?: Record<string, unknown>;
  runAfter?: string;
  maxAttempts?: number;
}): Promise<string> {
  const row = await sqlOne<{ id: string }>(
    `insert into bahi.jobs (tenant_id, kind, payload, run_after, max_attempts)
     values ($1, $2, $3::jsonb, coalesce($4::timestamptz, now()), $5)
     returning id`,
    [
      input.tenantId,
      input.kind,
      JSON.stringify(input.payload ?? {}),
      input.runAfter ?? null,
      input.maxAttempts ?? 5,
    ],
  );
  if (!row) throw new Error("The job could not be queued.");
  return String(row.id);
}

export async function listJobs(tenantId: string, limit = 10): Promise<JobRow[]> {
  const rows = await sql<RawJob>(
    `select id, tenant_id, kind, payload, status, attempts, max_attempts, last_error, run_after, created_at
       from bahi.jobs where tenant_id = $1 order by created_at desc limit $2`,
    [tenantId, limit],
  );
  return rows.map(toJob);
}

async function claimJobs(limit: number): Promise<RawJob[]> {
  // A crashed worker leaves rows in 'running'; return them to the queue once
  // the lock is older than the worker timeout.
  await sql(
    `update bahi.jobs
        set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
            last_error = coalesce(last_error, 'Worker stopped before the job finished.'),
            updated_at = now()
      where status = 'running' and locked_at < now() - interval '30 minutes'`,
  );
  const rows = await sql<RawJob>(
    `update bahi.jobs
        set status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
      where id in (
        select id from bahi.jobs
         where status = 'queued' and run_after <= now()
         order by run_after
         limit $1
         for update skip locked
      )
      returning id, tenant_id, kind, payload, status, attempts, max_attempts, last_error, run_after, created_at`,
    [limit],
  );
  return rows;
}

async function recordJobActivity(job: RawJob, action: string, detail: Record<string, unknown>) {
  if (!job.tenant_id) return;
  const tenant = await sqlOne<{ schema_name: string }>(
    `select schema_name from bahi.tenants where id = $1`,
    [job.tenant_id],
  );
  if (!tenant) return;
  await sql(
    `insert into ${table(tenant.schema_name, "activity")} (action, detail)
     values ($1, $2::jsonb)`,
    [action, JSON.stringify(detail)],
  );
}

export async function purgeTenantRetention(tenantId: string): Promise<{
  deleted: number;
  retentionDays: number;
}> {
  const tenant = await sqlOne<{ schema_name: string; retention_days: number }>(
    `select schema_name, retention_days from bahi.tenants where id = $1`,
    [tenantId],
  );
  if (!tenant) throw new Error("Workspace not found.");
  const days = Math.max(1, Number(tenant.retention_days) || 365);

  const rows = await sql<{ id: string; storage_path: string | null }>(
    `select id, storage_path from ${table(tenant.schema_name, "documents")}
      where status <> 'processing'
        and (
          (retention_until is not null and retention_until < now())
          or created_at < now() - ($1::int * interval '1 day')
        )`,
    [days],
  );

  if (rows.length) {
    const paths = rows
      .map((row) => row.storage_path)
      .filter((path): path is string => Boolean(path));
    for (let index = 0; index < paths.length; index += 100) {
      const chunk = paths.slice(index, index + 100);
      await adminClient()
        .storage.from("documents")
        .remove(chunk)
        .catch(() => undefined);
    }
    await sql(`delete from ${table(tenant.schema_name, "documents")} where id = any($1::uuid[])`, [
      rows.map((row) => row.id),
    ]);
  }

  await sql(`delete from bahi.sessions where expires_at < now()`);
  await sql(`delete from bahi.invites where expires_at < now() and accepted_at is null`);
  await sql(`delete from bahi.oauth_states where expires_at < now()`);

  return { deleted: rows.length, retentionDays: days };
}

interface DigestCounts {
  waiting: number;
  overdue: number;
  posted: number;
  postedValueMinor: number;
}

async function digestCounts(schema: string): Promise<DigestCounts> {
  const row = await sqlOne<{
    waiting: number;
    overdue: number;
    posted: number;
    posted_value: string;
  }>(
    `select
       count(*) filter (where status in ('pending_review','held'))::int as waiting,
       count(*) filter (where status in ('pending_review','held') and due_at < now())::int as overdue,
       count(*) filter (where status in ('posted','written') and posted_at >= now() - interval '1 day')::int as posted,
       coalesce(sum(amount_minor) filter (where status in ('posted','written') and posted_at >= now() - interval '1 day'), 0)::text as posted_value
     from ${table(schema, "records")}`,
  );
  return {
    waiting: Number(row?.waiting ?? 0),
    overdue: Number(row?.overdue ?? 0),
    posted: Number(row?.posted ?? 0),
    postedValueMinor: Number(row?.posted_value ?? 0),
  };
}

async function sendDigest(tenantId: string): Promise<void> {
  const session = await sessionForTenant(tenantId);
  if (!session) return;
  if (!session.settings.notifications.email || session.settings.notifications.digest === "off") {
    return;
  }
  if (!env.notifications.emailUrl) return;

  const counts = await digestCounts(session.schema);
  const rupees = (counts.postedValueMinor / 100).toLocaleString("en-IN");
  const text = [
    `${session.tenantName} — daily summary`,
    "",
    `${counts.posted} record${counts.posted === 1 ? "" : "s"} entered in the last day (₹${rupees}).`,
    `${counts.waiting} waiting for review, ${counts.overdue} overdue.`,
    "",
    "Open Bahi to review the queue.",
  ].join("\n");

  const response = await fetch(env.notifications.emailUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.notifications.emailKey
        ? { authorization: `Bearer ${env.notifications.emailKey}` }
        : {}),
    },
    body: JSON.stringify({
      to: session.email,
      subject: `Bahi daily summary — ${counts.posted} entered, ${counts.waiting} waiting`,
      text,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`The email provider returned ${response.status}.`);
  }
}

async function execute(job: RawJob): Promise<void> {
  switch (job.kind) {
    case "retention.purge": {
      if (!job.tenant_id) throw new Error("Retention jobs need a workspace.");
      const result = await purgeTenantRetention(job.tenant_id);
      await recordJobActivity(job, "retention.purged", result);
      return;
    }
    case "intake.process":
      await processIntakeJob(job.payload);
      return;
    case "notifications.digest": {
      if (!job.tenant_id) throw new Error("Digest jobs need a workspace.");
      await sendDigest(job.tenant_id);
      return;
    }
    default:
      throw new Error(`Unknown job kind ${job.kind}.`);
  }
}

async function runJob(job: RawJob): Promise<boolean> {
  try {
    await execute(job);
    await sql(
      `update bahi.jobs set status = 'done', last_error = null, updated_at = now() where id = $1`,
      [job.id],
    );
    return true;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message.slice(0, 500) : "Job failed.";
    const final = Number(job.attempts) >= Number(job.max_attempts);
    const delayMinutes = Math.min(60, Number(job.attempts) ** 2);
    await sql(
      `update bahi.jobs
          set status = $2,
              last_error = $3,
              run_after = now() + ($4::int * interval '1 minute'),
              updated_at = now()
        where id = $1`,
      [job.id, final ? "failed" : "queued", message, delayMinutes],
    );
    return false;
  }
}

export async function runJobById(id: string): Promise<{ ok: boolean; error?: string }> {
  const claimed = await sqlOne<RawJob>(
    `update bahi.jobs
        set status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
      where id = $1 and status in ('queued', 'failed')
      returning id, tenant_id, kind, payload, status, attempts, max_attempts, last_error, run_after, created_at`,
    [id],
  );
  if (!claimed) return { ok: false, error: "That job is already running or done." };
  const ok = await runJob(claimed);
  return ok ? { ok } : { ok, error: "The job failed and will be retried." };
}

export async function runDueJobs(limit = 10): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
  for (;;) {
    const batch = await claimJobs(Math.max(1, Math.min(25, limit - processed)));
    if (!batch.length) break;
    for (const job of batch) {
      const ok = await runJob(job);
      processed += 1;
      if (!ok) failed += 1;
      if (processed >= limit) break;
    }
    if (processed >= limit) break;
  }
  return { processed, failed };
}

/**
 * Queues the once-a-day work. Called by the cron endpoint; every enqueue is
 * guarded so calling it more than once a day does not duplicate work.
 */
export async function scheduleDailyJobs(): Promise<{ queued: number }> {
  const tenants = await sql<{ id: string; settings: Record<string, unknown> | null }>(
    `select id, settings from bahi.tenants where status = 'active'`,
  );
  let queued = 0;
  for (const tenant of tenants) {
    const recent = await sqlOne<{ id: string }>(
      `select id from bahi.jobs
        where tenant_id = $1 and kind = 'retention.purge'
          and created_at > now() - interval '20 hours'
        limit 1`,
      [tenant.id],
    );
    if (!recent) {
      await enqueueJob({ tenantId: tenant.id, kind: "retention.purge" });
      queued += 1;
    }

    const notifications = (tenant.settings?.["notifications"] ?? {}) as {
      email?: boolean;
      digest?: string;
    };
    if (notifications.email && notifications.digest && notifications.digest !== "off") {
      const digest = await sqlOne<{ id: string }>(
        `select id from bahi.jobs
          where tenant_id = $1 and kind = 'notifications.digest'
            and created_at > now() - interval '20 hours'
          limit 1`,
        [tenant.id],
      );
      if (!digest) {
        await enqueueJob({
          tenantId: tenant.id,
          kind: "notifications.digest",
          runAfter: new Date(Date.now() + 60_000).toISOString(),
        });
        queued += 1;
      }
    }
  }
  return { queued };
}
