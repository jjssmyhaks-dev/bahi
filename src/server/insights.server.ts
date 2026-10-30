import type { SessionUser } from "@/lib/types";
import { autonomyStatus, type AutonomyStatus } from "./autonomy.server";
import { sql, table } from "./db.server";
import { getQueueMetrics, type QueueMetrics } from "./repo.server";

export interface InsightsData {
  windowDays: number;
  totals: {
    records: number;
    autoPosted: number;
    manualPosted: number;
    rejected: number;
    open: number;
    postedValueMinor: number;
    corrections: number;
  };
  automationRatePct: number;
  postsByDestination: { destination: string; count: number; valueMinor: number }[];
  confidenceBands: { band: string; count: number }[];
  topReviewReasons: { reason: string; count: number }[];
  agents: {
    agent: string;
    runs: number;
    modelRuns: number;
    failures: number;
    costUsd: number;
    avgLatencyMs: number;
  }[];
  documents: { channel: string; count: number; vision: number }[];
  learning: { confirmed: number; proposed: number; ignored: number };
  queue: QueueMetrics;
  autonomy: AutonomyStatus;
}

const WINDOW_DAYS = 30;

export async function getInsights(session: SessionUser): Promise<InsightsData> {
  const schema = session.schema;
  const [totals, destinations, bands, reasons, agents, documents, learning, queue, autonomy] =
    await Promise.all([
      sql<{
        records: number;
        auto_posted: number;
        manual_posted: number;
        rejected: number;
        open: number;
        posted_value: string;
        corrections: string;
      }>(
        `select
           count(*)::int as records,
           count(*) filter (where reviewed_at is null and status in ('posted','written'))::int as auto_posted,
           count(*) filter (where reviewed_at is not null and status in ('posted','written'))::int as manual_posted,
           count(*) filter (where status = 'rejected')::int as rejected,
           count(*) filter (where status in ('pending_review','held'))::int as open,
           coalesce(sum(amount_minor) filter (where status in ('posted','written')), 0)::text as posted_value,
           (select count(*) from ${table(schema, "corrections")}
             where created_at >= now() - ($1::int * interval '1 day'))::text as corrections
         from ${table(schema, "records")}
        where created_at >= now() - ($1::int * interval '1 day')`,
        [WINDOW_DAYS],
      ),
      sql<{ destination: string; n: number; value: string }>(
        `select destination, count(*)::int as n, coalesce(sum(amount_minor), 0)::text as value
           from ${table(schema, "records")}
          where posted_at >= now() - ($1::int * interval '1 day')
          group by destination order by n desc`,
        [WINDOW_DAYS],
      ),
      sql<{ band: string; n: number }>(
        `select case
                  when overall_confidence >= 0.95 then '95–100%'
                  when overall_confidence >= 0.9 then '90–94%'
                  when overall_confidence >= 0.8 then '80–89%'
                  when overall_confidence >= 0.7 then '70–79%'
                  else 'Below 70%'
                end as band,
                count(*)::int as n
           from ${table(schema, "records")}
          where created_at >= now() - ($1::int * interval '1 day')
          group by band`,
        [WINDOW_DAYS],
      ),
      sql<{ reason: string; n: number }>(
        `select coalesce(nullif(review_reason, ''), nullif(reason, ''), 'Other reason') as reason,
                count(*)::int as n
           from ${table(schema, "records")}
          where created_at >= now() - ($1::int * interval '1 day')
            and status in ('pending_review','held','rejected')
          group by 1 order by n desc limit 5`,
        [WINDOW_DAYS],
      ),
      sql<{
        agent: string;
        runs: number;
        model_runs: number;
        failures: number;
        cost: string;
        latency: number;
      }>(
        `select agent, count(*)::int as runs,
                count(*) filter (where mode = 'model')::int as model_runs,
                count(*) filter (where status = 'failed')::int as failures,
                coalesce(sum(cost_usd), 0)::text as cost,
                coalesce(round(avg(latency_ms)), 0)::int as latency
           from ${table(schema, "agent_runs")}
          where created_at >= now() - ($1::int * interval '1 day')
          group by agent order by runs desc`,
        [WINDOW_DAYS],
      ),
      sql<{ channel: string; n: number; vision: number }>(
        `select source_channel as channel, count(*)::int as n,
                count(*) filter (where render_mode = 'vision')::int as vision
           from ${table(schema, "documents")}
          where created_at >= now() - ($1::int * interval '1 day')
          group by source_channel order by n desc`,
        [WINDOW_DAYS],
      ),
      sql<{ status: string; n: number }>(
        `select status, count(*)::int as n from ${table(schema, "rule_proposals")} group by status`,
      ),
      getQueueMetrics(schema),
      autonomyStatus(session),
    ]);

  const row = totals[0];
  const autoPosted = Number(row?.auto_posted ?? 0);
  const manualPosted = Number(row?.manual_posted ?? 0);
  const decided = autoPosted + manualPosted;
  const learningCounts = new Map(learning.map((entry) => [entry.status, Number(entry.n)]));

  return {
    windowDays: WINDOW_DAYS,
    totals: {
      records: Number(row?.records ?? 0),
      autoPosted,
      manualPosted,
      rejected: Number(row?.rejected ?? 0),
      open: Number(row?.open ?? 0),
      postedValueMinor: Number(row?.posted_value ?? 0),
      corrections: Number(row?.corrections ?? 0),
    },
    automationRatePct: decided ? Math.round((autoPosted / decided) * 1000) / 10 : 0,
    postsByDestination: destinations.map((entry) => ({
      destination: entry.destination,
      count: Number(entry.n),
      valueMinor: Number(entry.value),
    })),
    confidenceBands: bands.map((entry) => ({ band: entry.band, count: Number(entry.n) })),
    topReviewReasons: reasons.map((entry) => ({
      reason: String(entry.reason).slice(0, 180),
      count: Number(entry.n),
    })),
    agents: agents.map((entry) => ({
      agent: entry.agent,
      runs: Number(entry.runs),
      modelRuns: Number(entry.model_runs),
      failures: Number(entry.failures),
      costUsd: Math.round(Number(entry.cost) * 1_000_000) / 1_000_000,
      avgLatencyMs: Number(entry.latency),
    })),
    documents: documents.map((entry) => ({
      channel: entry.channel,
      count: Number(entry.n),
      vision: Number(entry.vision),
    })),
    learning: {
      confirmed: learningCounts.get("confirmed") ?? 0,
      proposed: learningCounts.get("proposed") ?? 0,
      ignored: learningCounts.get("ignored") ?? 0,
    },
    queue,
    autonomy,
  };
}
