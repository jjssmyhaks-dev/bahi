import type { AutonomyStage, SessionUser } from "@/lib/types";
import { sql, sqlOne, table } from "./db.server";

const WINDOW_DAYS = 14;
const MIN_SAMPLE = 5;

export interface AutonomyEventRow {
  id: string;
  stageFrom: number | null;
  stageTo: number;
  reason: string;
  createdAt: string;
}

export interface AutonomyStatus {
  stage: AutonomyStage;
  shadowMode: boolean;
  errorBudgetPct: number;
  windowDays: number;
  autoPosts: number;
  reversals: number;
  errorRatePct: number;
  overBudget: boolean;
  events: AutonomyEventRow[];
}

function clampStage(value: number): AutonomyStage {
  return Math.max(0, Math.min(4, Math.round(value))) as AutonomyStage;
}

export async function autonomyStatus(session: SessionUser): Promise<AutonomyStatus> {
  const [sample, events] = await Promise.all([
    sqlOne<{ auto_posts: number; reversals: number }>(
      `select count(*)::int as auto_posts,
              count(*) filter (
                where exists (
                  select 1 from ${table(session.schema, "posts")} p
                   where p.record_id = r.id and p.reversed_at is not null
                )
              )::int as reversals
         from ${table(session.schema, "records")} r
        where r.status in ('posted', 'written')
          and r.reviewed_at is null
          and r.posted_at >= now() - ($1::int * interval '1 day')`,
      [WINDOW_DAYS],
    ),
    sql<{
      id: string;
      stage_from: number | null;
      stage_to: number;
      reason: string;
      created_at: Date;
    }>(
      `select id, stage_from, stage_to, reason, created_at
         from ${table(session.schema, "autonomy_events")}
        order by created_at desc limit 10`,
    ),
  ]);

  const autoPosts = Number(sample?.auto_posts ?? 0);
  const reversals = Number(sample?.reversals ?? 0);
  const errorRatePct = autoPosts ? Math.round((reversals / autoPosts) * 1000) / 10 : 0;
  const budget = Number(session.settings.autonomy.errorBudgetPct);

  return {
    stage: clampStage(session.autonomyStage),
    shadowMode: session.shadowMode,
    errorBudgetPct: budget,
    windowDays: WINDOW_DAYS,
    autoPosts,
    reversals,
    errorRatePct,
    overBudget: autoPosts >= MIN_SAMPLE && errorRatePct > budget,
    events: events.map((row) => ({
      id: String(row.id),
      stageFrom: row.stage_from === null ? null : Number(row.stage_from),
      stageTo: Number(row.stage_to),
      reason: String(row.reason),
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

/**
 * Downgrades one stage when reversals of automatic posts exceed the owner's
 * error budget. The budget protects the books while the rules learn; the owner
 * has to move the stage back up explicitly.
 */
export async function enforceErrorBudget(session: SessionUser): Promise<{
  stage: AutonomyStage;
  downgraded: boolean;
  status: AutonomyStatus;
}> {
  const status = await autonomyStatus(session);
  if (!status.overBudget || status.stage <= 1) {
    return { stage: status.stage, downgraded: false, status };
  }

  const next = clampStage(status.stage - 1);
  await sql(`update bahi.tenants set autonomy_stage = $2, updated_at = now() where id = $1`, [
    session.tenantId,
    next,
  ]);
  await sql(
    `insert into ${table(session.schema, "autonomy_events")}
       (stage_from, stage_to, reason, metrics)
     values ($1, $2, $3, $4::jsonb)`,
    [
      status.stage,
      next,
      `Automatic downgrade: ${status.reversals} of ${status.autoPosts} automatic posts were reversed (${status.errorRatePct}% against a ${status.errorBudgetPct}% budget).`,
      JSON.stringify({
        autoPosts: status.autoPosts,
        reversals: status.reversals,
        errorRatePct: status.errorRatePct,
        errorBudgetPct: status.errorBudgetPct,
      }),
    ],
  );
  await sql(
    `insert into ${table(session.schema, "activity")} (action, detail)
     values ('autonomy.downgraded', $1::jsonb)`,
    [
      JSON.stringify({
        stageFrom: status.stage,
        stageTo: next,
        errorRatePct: status.errorRatePct,
        errorBudgetPct: status.errorBudgetPct,
      }),
    ],
  );

  session.autonomyStage = next;
  return {
    stage: next,
    downgraded: true,
    status: { ...status, stage: next, overBudget: false },
  };
}
