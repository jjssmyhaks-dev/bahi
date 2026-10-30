import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  CheckCircle2,
  CircleDollarSign,
  Columns3,
  Loader2,
  RefreshCw,
  Sparkles,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/app/page-header";
import { formatDateTime } from "@/lib/format";
import {
  agentsFn,
  confirmSheetMappingFn,
  reviewProposalFn,
  runCuratorFn,
  workspaceFn,
} from "@/lib/api";

export const Route = createFileRoute("/app/agents")({
  head: () => ({ meta: [{ title: "Agents — Bahi" }] }),
  component: AgentsPage,
});

const AGENT_LABELS: Record<string, string> = {
  chat_orchestrator: "Chat orchestrator",
  document_classifier: "Document classifier",
  extraction: "Extraction",
  master_matcher: "Supplier matcher",
  validation_explainer: "Validation explainer",
  destination_mapper: "Sheet mapper",
  bank_categoriser: "Bank categoriser",
  learning_curator: "Learning curator",
};

function AgentsPage() {
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => agentsFn() });
  const workspace = useQuery({ queryKey: ["workspace"], queryFn: () => workspaceFn() });
  const [busy, setBusy] = useState<string | null>(null);

  const isOwner = workspace.data?.user.role === "owner";
  const data = agents.data;

  async function refresh() {
    await queryClient.invalidateQueries();
  }

  async function curate() {
    setBusy("curate");
    try {
      const result = await runCuratorFn();
      toast.success(
        result.saved
          ? `${result.saved} repeated correction${result.saved === 1 ? "" : "s"} turned into a proposal.`
          : "No correction has repeated enough to propose a rule yet.",
      );
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not run the curator.");
    } finally {
      setBusy(null);
    }
  }

  async function review(proposalId: string, decision: "confirmed" | "ignored") {
    setBusy(proposalId);
    try {
      await reviewProposalFn({ data: { proposalId, decision } });
      toast.success(
        decision === "confirmed" ? "Rule confirmed and now in use." : "Proposal ignored.",
      );
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not review that proposal.");
    } finally {
      setBusy(null);
    }
  }

  async function confirmMapping() {
    if (!data?.mapping) return;
    setBusy("mapping");
    try {
      await confirmSheetMappingFn({ data: { columns: data.mapping.columns } });
      toast.success("Sheet mapping confirmed. New rows use this layout.");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not confirm the mapping.");
    } finally {
      setBusy(null);
    }
  }

  if (agents.isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const totals = data?.totals;
  const modelMode = (totals?.modelRuns ?? 0) > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Agents"
        title="The team behind every entry"
        description="Eight agents read, match, check and explain each document. This page shows what they ran, what they cost and what they learned from your corrections."
        actions={
          <button
            type="button"
            onClick={() => void agents.refetch()}
            className="btn-outline h-9 px-4 text-xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${agents.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </button>
        }
      />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Agent runs", value: totals?.runs ?? 0, note: "Last 30 days" },
          {
            label: "Model calls",
            value: totals?.modelRuns ?? 0,
            note: modelMode ? "AI enabled" : "Rules only",
          },
          { label: "Failures", value: totals?.failures ?? 0, note: "Escalated to review" },
          {
            label: "Model spend",
            value: `$${(totals?.costUsd ?? 0).toFixed(4)}`,
            note: `${(totals?.inputTokens ?? 0).toLocaleString()} in / ${(totals?.outputTokens ?? 0).toLocaleString()} out`,
          },
        ].map((card) => (
          <div key={card.label} className="rounded-2xl border border-border bg-card p-4">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              {card.label}
            </p>
            <p className="mt-2 text-2xl font-semibold tracking-tight">{card.value}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">{card.note}</p>
          </div>
        ))}
      </section>

      <p className="rounded-2xl border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
        {modelMode
          ? "A model is configured, so agents call it when the deterministic rules are not certain. Every call is logged here and can fall back to the rule engine."
          : "No AI key is configured. Every agent is running its deterministic path: the same checks, matching and explanations, without external model calls. Add AI_API_KEY in the environment to let agents handle ambiguous cases."}
      </p>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">What the agents learned</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Repeated corrections become proposals. Nothing changes until the owner confirms it.
            </p>
          </div>
          {isOwner ? (
            <button
              type="button"
              onClick={curate}
              disabled={busy !== null}
              className="btn-outline h-9 px-4 text-xs"
            >
              {busy === "curate" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              Find repeated corrections
            </button>
          ) : null}
        </div>

        {data?.proposals.length ? (
          <ul className="mt-4 space-y-2">
            {data.proposals.map((proposal) => (
              <li key={proposal.id} className="rounded-xl border border-border px-3.5 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold">
                      {proposal.rule.description || proposal.example || "Suggested rule"}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Seen {proposal.evidenceCount} time{proposal.evidenceCount === 1 ? "" : "s"} ·{" "}
                      {proposal.rule.kind.replace(/_/g, " ")}
                      {proposal.example ? ` · ${proposal.example}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                        proposal.status === "proposed"
                          ? "bg-chip text-chip-foreground"
                          : proposal.status === "confirmed"
                            ? "bg-muted text-foreground"
                            : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {proposal.status}
                    </span>
                    {isOwner && proposal.status === "proposed" ? (
                      <>
                        <button
                          type="button"
                          onClick={() => review(proposal.id, "confirmed")}
                          disabled={busy !== null}
                          className="btn-primary h-8 px-3 text-xs"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Confirm
                        </button>
                        <button
                          type="button"
                          onClick={() => review(proposal.id, "ignored")}
                          disabled={busy !== null}
                          className="btn-outline h-8 px-3 text-xs"
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          Ignore
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 rounded-xl bg-muted/60 px-3 py-2.5 text-xs text-muted-foreground">
            No proposals yet. Correct the same field on a supplier three times — for example a
            ledger or place of supply — and the curator will suggest a rule.
          </p>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Columns3 className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-sm font-semibold">Google Sheet layout</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {data?.mapping
                  ? `${data.mapping.spreadsheetName} · ${data.mapping.sheetName} · ${data.mapping.status}`
                  : "No sheet connection yet."}
              </p>
            </div>
          </div>
          {isOwner && data?.mapping?.status === "proposed" ? (
            <button
              type="button"
              onClick={confirmMapping}
              disabled={busy !== null}
              className="btn-primary h-9 px-4 text-xs"
            >
              {busy === "mapping" ? "Confirming…" : "Confirm mapping"}
            </button>
          ) : null}
        </div>

        {data?.mapping?.columns.length ? (
          <div className="mt-4 overflow-hidden rounded-xl border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-semibold">Sheet column</th>
                  <th className="px-3 py-2 font-semibold">Record field</th>
                </tr>
              </thead>
              <tbody>
                {data.mapping.columns.map((column) => (
                  <tr key={column.column} className="border-t border-border">
                    <td className="px-3 py-2">{column.column}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {column.field ??
                        (column.fixedValue ? `fixed: ${column.fixedValue}` : "unmapped")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-muted-foreground" />
          <p className="text-sm font-semibold">Recent agent runs</p>
        </div>
        {data?.runs.length ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="pb-2 pr-3 font-semibold">Agent</th>
                  <th className="pb-2 pr-3 font-semibold">Mode</th>
                  <th className="pb-2 pr-3 font-semibold">Status</th>
                  <th className="pb-2 pr-3 font-semibold">Tokens</th>
                  <th className="pb-2 pr-3 font-semibold">Time</th>
                  <th className="pb-2 font-semibold">When</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((run) => (
                  <tr key={run.id} className="border-t border-border">
                    <td className="py-2 pr-3">
                      <span className="font-medium">
                        {AGENT_LABELS[run.agent] ?? run.agent.replace(/_/g, " ")}
                      </span>
                      <span className="block text-[10px] text-muted-foreground">
                        {run.model ?? run.promptVersion}
                      </span>
                    </td>
                    <td className="py-2 pr-3 capitalize text-muted-foreground">{run.mode}</td>
                    <td className="py-2 pr-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          run.status === "ok"
                            ? "bg-chip text-chip-foreground"
                            : "bg-destructive/10 text-destructive"
                        }`}
                      >
                        {run.status}
                      </span>
                      {run.error ? (
                        <span className="mt-1 block text-[10px] text-destructive">{run.error}</span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground">
                      {run.inputTokens + run.outputTokens}
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground">{run.latencyMs} ms</td>
                    <td className="py-2 text-muted-foreground">{formatDateTime(run.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-4 flex items-center gap-2 rounded-xl bg-muted/60 px-3 py-2.5 text-xs text-muted-foreground">
            <CircleDollarSign className="h-3.5 w-3.5" />
            Model calls appear here when agents need them. Deterministic runs do not spend anything.
          </p>
        )}
      </section>

      <p className="text-[11px] text-muted-foreground">
        Agents never write to Tally, Excel or Sheets themselves and never hold destination
        credentials. They propose; the router and your approval decide.
      </p>
    </div>
  );
}
