import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Bot,
  FileText,
  Gauge,
  Inbox,
  Loader2,
  RefreshCw,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

import { PageHeader } from "@/components/app/page-header";
import { DESTINATION_LABELS, formatINR } from "@/lib/format";
import type { Destination } from "@/lib/types";
import { insightsFn } from "@/lib/api";

export const Route = createFileRoute("/app/insights")({
  head: () => ({ meta: [{ title: "Insights — Bahi" }] }),
  component: InsightsPage,
});

const STAGE_LABELS: Record<number, string> = {
  0: "Read only",
  1: "Draft for review",
  2: "Write with approval",
  3: "Auto-write high confidence",
  4: "Fully autonomous",
};

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <p className="text-sm font-semibold">{title}</p>
      {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function BarRow({
  label,
  value,
  max,
  detail,
}: {
  label: string;
  value: number;
  max: number;
  detail?: string;
}) {
  const width = max > 0 ? Math.max(4, Math.round((value / max) * 100)) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="truncate font-medium">{label}</span>
        <span className="shrink-0 text-muted-foreground">{detail ?? value}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-foreground/70" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function InsightsPage() {
  const insights = useQuery({
    queryKey: ["insights"],
    queryFn: () => insightsFn(),
  });

  const data = insights.data;
  const busy = insights.isLoading;

  const maxReason = Math.max(0, ...(data?.topReviewReasons.map((row) => row.count) ?? [0]));
  const maxBand = Math.max(0, ...(data?.confidenceBands.map((row) => row.count) ?? [0]));
  const maxDestination = Math.max(0, ...(data?.postsByDestination.map((row) => row.count) ?? [0]));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Insights"
        title="How the books are running"
        description="The last 30 days: what Bahi wrote on its own, where it needed a person, and what the agents cost."
        actions={
          <button
            type="button"
            onClick={() => void insights.refetch()}
            className="btn-outline h-9 px-4 text-xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${insights.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </button>
        }
      />

      {busy ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : insights.isError || !data ? (
        <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Could not load insights. Refresh to try again.
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                label: "Automation rate",
                value: `${data.automationRatePct}%`,
                detail: `${data.totals.autoPosted} of ${data.totals.autoPosted + data.totals.manualPosted} entered without a person`,
                icon: <Sparkles className="h-4 w-4" />,
              },
              {
                label: "Posted value",
                value: formatINR(data.totals.postedValueMinor),
                detail: `${data.totals.autoPosted + data.totals.manualPosted} entries written`,
                icon: <FileText className="h-4 w-4" />,
              },
              {
                label: "Waiting on a person",
                value: String(data.totals.open),
                detail: `${data.queue.overdue} overdue · ${data.queue.unassigned} unassigned`,
                icon: <Inbox className="h-4 w-4" />,
              },
              {
                label: "Corrections",
                value: String(data.totals.corrections),
                detail: `${data.totals.rejected} rejected in 30 days`,
                icon: <Activity className="h-4 w-4" />,
              },
            ].map((tile) => (
              <div key={tile.label} className="rounded-2xl border border-border bg-card p-4">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {tile.label}
                  </p>
                  <span className="text-muted-foreground">{tile.icon}</span>
                </div>
                <p className="mt-2 text-2xl font-semibold tracking-tight">{tile.value}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">{tile.detail}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section
              title="Autonomy"
              description="How much Bahi is trusted, and how the error budget is holding."
            >
              <div className="flex items-center gap-3">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-secondary">
                  <Gauge className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-sm font-semibold">
                    Stage {data.autonomy.stage} · {STAGE_LABELS[data.autonomy.stage] ?? "Custom"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {data.autonomy.shadowMode
                      ? "Shadow mode: decisions are logged but nothing is written."
                      : "Live: decisions are written to the destination."}
                  </p>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
                <div className="rounded-xl bg-muted/60 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Auto posts
                  </p>
                  <p className="mt-0.5 text-base font-semibold">{data.autonomy.autoPosts}</p>
                </div>
                <div className="rounded-xl bg-muted/60 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Reversed
                  </p>
                  <p className="mt-0.5 text-base font-semibold">{data.autonomy.reversals}</p>
                </div>
                <div
                  className={`rounded-xl px-3 py-2 ${
                    data.autonomy.overBudget ? "bg-destructive/10" : "bg-muted/60"
                  }`}
                >
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Error rate
                  </p>
                  <p className="mt-0.5 text-base font-semibold">{data.autonomy.errorRatePct}%</p>
                </div>
              </div>
              {data.autonomy.overBudget ? (
                <p className="mt-3 flex items-start gap-2 rounded-xl bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Over the {data.autonomy.errorBudgetPct}% budget. Bahi drops a stage on the next
                  document until the books settle.
                </p>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">
                  Within the {data.autonomy.errorBudgetPct}% error budget over the last{" "}
                  {data.autonomy.windowDays} days.
                </p>
              )}
              {data.autonomy.events.length ? (
                <ul className="mt-3 space-y-1.5">
                  {data.autonomy.events.slice(0, 3).map((event) => (
                    <li key={event.id} className="text-xs text-muted-foreground">
                      · Stage {event.stageFrom ?? "—"} → {event.stageTo}: {event.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Section>

            <Section
              title="Why records waited"
              description="The most common reasons a person was needed."
            >
              {data.topReviewReasons.length ? (
                <div className="space-y-3">
                  {data.topReviewReasons.map((row) => (
                    <BarRow key={row.reason} label={row.reason} value={row.count} max={maxReason} />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Nothing is waiting right now.</p>
              )}
            </Section>

            <Section title="Where entries went" description="Posted records by destination.">
              {data.postsByDestination.length ? (
                <div className="space-y-3">
                  {data.postsByDestination.map((row) => (
                    <BarRow
                      key={row.destination}
                      label={DESTINATION_LABELS[row.destination as Destination] ?? row.destination}
                      value={row.count}
                      max={maxDestination}
                      detail={`${row.count} · ${formatINR(row.valueMinor)}`}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Nothing written yet.</p>
              )}
            </Section>

            <Section
              title="Reading confidence"
              description="How sure Bahi was when it finished reading."
            >
              {data.confidenceBands.length ? (
                <div className="space-y-3">
                  {data.confidenceBands.map((row) => (
                    <BarRow key={row.band} label={row.band} value={row.count} max={maxBand} />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No documents in this window.</p>
              )}
            </Section>
          </div>

          <Section title="Agents" description="Runs, model use and cost across the last 30 days.">
            {data.agents.length ? (
              <div className="overflow-hidden rounded-xl border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-muted text-left text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Agent</th>
                      <th className="px-3 py-2 text-right font-semibold">Runs</th>
                      <th className="px-3 py-2 text-right font-semibold">Model</th>
                      <th className="px-3 py-2 text-right font-semibold">Failed</th>
                      <th className="px-3 py-2 text-right font-semibold">Avg ms</th>
                      <th className="px-3 py-2 text-right font-semibold">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.agents.map((agent) => (
                      <tr key={agent.agent} className="border-t border-border">
                        <td className="px-3 py-2 font-medium capitalize">
                          <span className="inline-flex items-center gap-1.5">
                            <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                            {agent.agent.replace(/_/g, " ")}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">{agent.runs}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">
                          {agent.modelRuns}
                        </td>
                        <td
                          className={`px-3 py-2 text-right ${
                            agent.failures ? "text-destructive" : "text-muted-foreground"
                          }`}
                        >
                          {agent.failures}
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground">
                          {agent.avgLatencyMs}
                        </td>
                        <td className="px-3 py-2 text-right">${agent.costUsd.toFixed(4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No agent runs in this window.</p>
            )}
          </Section>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Learning" description="Vendor rules Bahi proposed and you confirmed.">
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                {[
                  { label: "Confirmed", value: data.learning.confirmed },
                  { label: "Proposed", value: data.learning.proposed },
                  { label: "Ignored", value: data.learning.ignored },
                ].map((item) => (
                  <div key={item.label} className="rounded-xl bg-muted/60 px-3 py-3">
                    <p className="text-lg font-semibold">{item.value}</p>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {item.label}
                    </p>
                  </div>
                ))}
              </div>
              <Link to="/app/agents" className="mt-4 inline-block text-xs font-medium underline">
                Review proposed rules
              </Link>
            </Section>

            <Section
              title="Documents"
              description="Where documents came from and how they were read."
            >
              {data.documents.length ? (
                <div className="space-y-2">
                  {data.documents.map((row) => (
                    <div
                      key={row.channel}
                      className="flex items-center justify-between rounded-xl bg-muted/60 px-3 py-2 text-xs"
                    >
                      <span className="font-medium capitalize">{row.channel}</span>
                      <span className="text-muted-foreground">
                        {row.count} file{row.count === 1 ? "" : "s"}
                        {row.vision ? ` · ${row.vision} read from photo` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No documents in this window.</p>
              )}
            </Section>
          </div>
        </>
      )}
    </div>
  );
}
