import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { DestinationBadge, StatusBadge } from "@/components/app/status-badge";
import { DOC_TYPE_LABELS, formatDate, formatINR } from "@/lib/format";
import { permissionLabel } from "@/lib/permissions";
import type { RecordRow } from "@/lib/types";

export function RecordCard({
  record,
  onOpen,
  actions,
  selectable = false,
  selected = false,
  onSelect,
}: {
  record: RecordRow;
  onOpen?: (id: string) => void;
  actions?: ReactNode;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (id: string, next: boolean) => void;
}) {
  const failed = record.validation.filter((rule) => rule.outcome === "fail");
  const warned = record.validation.filter((rule) => rule.outcome === "warn");
  const problems = [...failed, ...warned].slice(0, 2);
  const confidence = Math.round(record.overallConfidence * 100);
  const overdue =
    record.dueAt &&
    (record.status === "pending_review" || record.status === "held") &&
    new Date(record.dueAt).getTime() < Date.now();

  return (
    <article
      className={`rounded-2xl border bg-card p-4 transition-colors hover:border-foreground/20 ${
        selected ? "border-foreground/40 ring-1 ring-foreground/10" : "border-border"
      }`}
    >
      <div className="flex items-start gap-3">
        {selectable ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={(event) => onSelect?.(record.id, event.target.checked)}
            aria-label={`Select ${record.title}`}
            className="mt-1 h-4 w-4 shrink-0 accent-foreground"
          />
        ) : null}
        <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className="truncate text-sm font-semibold">{record.title}</p>
              <StatusBadge status={record.status} />
              {overdue ? (
                <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive">
                  Overdue
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {DOC_TYPE_LABELS[record.docType]}
              {record.fields.invoice_date
                ? ` · ${formatDate(String(record.fields.invoice_date))}`
                : ""}
              {record.fields.vendor_gstin ? ` · ${String(record.fields.vendor_gstin)}` : ""}
            </p>
            {record.assignedToName || record.dueAt ? (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {record.assignedToName ? `With ${record.assignedToName}` : "Unassigned"}
                {record.dueAt ? ` · due ${formatDate(record.dueAt)}` : ""}
              </p>
            ) : null}
          </div>
          <div className="shrink-0 text-right">
            <p className="text-sm font-semibold">{formatINR(record.amountMinor)}</p>
            <div className="mt-1 flex justify-end">
              <DestinationBadge destination={record.destination} />
            </div>
          </div>
        </div>
      </div>

      {record.status === "posted" || record.status === "written" ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Entered as {record.destinationRef ?? "—"}
          {record.approvedPermissionLevel || record.permissionLevel
            ? ` under ${permissionLabel(record.approvedPermissionLevel ?? record.permissionLevel)}`
            : ""}
          .
        </p>
      ) : problems.length ? (
        <ul className="mt-3 space-y-1.5 rounded-xl bg-muted/60 px-3 py-2.5 text-xs text-foreground/80">
          {problems.map((rule) => (
            <li key={rule.id} className="flex gap-2">
              <span
                className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                  rule.outcome === "fail" ? "bg-destructive" : "bg-foreground/40"
                }`}
              />
              <span>{rule.message}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">All checks passed.</p>
      )}

      <div className="mt-3 flex items-center gap-3">
        <div className="flex flex-1 items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full ${confidence >= 95 ? "bg-foreground" : "bg-foreground/50"}`}
              style={{ width: `${confidence}%` }}
            />
          </div>
          <span className="text-[11px] font-medium text-muted-foreground">{confidence}% sure</span>
        </div>
        {actions}
        {onOpen ? (
          <button
            type="button"
            onClick={() => onOpen(record.id)}
            className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
          >
            Open
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </article>
  );
}
