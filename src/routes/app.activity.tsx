import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  FilePlus2,
  FileSpreadsheet,
  FileWarning,
  Loader2,
  PauseCircle,
  PencilLine,
  RefreshCw,
  Settings,
  XCircle,
} from "lucide-react";

import { PageHeader } from "@/components/app/page-header";
import { RecordDetail } from "@/components/app/record-detail";
import { DOC_TYPE_LABELS, DESTINATION_LABELS, formatDateTime } from "@/lib/format";
import type { ActivityRow, Destination, DocType, JsonValue } from "@/lib/types";
import { activityFn } from "@/lib/api";

export const Route = createFileRoute("/app/activity")({
  head: () => ({ meta: [{ title: "Activity — Bahi" }] }),
  component: ActivityPage,
});

function text(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function describe(row: ActivityRow): { icon: React.ReactNode; title: string; detail: string } {
  const detail = row.detail;
  const destinationKey = text(detail["destination"]);
  const destination =
    destinationKey === "tally" || destinationKey === "excel" || destinationKey === "google_sheets"
      ? DESTINATION_LABELS[destinationKey as Destination]
      : "";
  const ref = text(detail["externalRef"]);
  const source = text(detail["source"]);

  switch (row.action) {
    case "record.posted":
    case "record.written":
      return {
        icon: <CheckCircle2 className="h-4 w-4" />,
        title: `Entered in ${destination || "destination"}${ref ? ` as ${ref}` : ""}`,
        detail:
          source === "manual"
            ? "Approved by a person."
            : "Posted automatically after the checks passed.",
      };
    case "record.created": {
      const type = text(detail["docType"]);
      const confidence = Number(text(detail["confidence"]) || 0);
      const status = text(detail["status"]);
      return {
        icon: <FilePlus2 className="h-4 w-4" />,
        title: `Read a ${type in DOC_TYPE_LABELS ? DOC_TYPE_LABELS[type as DocType] : "document"} at ${Math.round(confidence * 100)}% confidence`,
        detail:
          status === "auto_post"
            ? "Sent straight to the destination."
            : "Sent to the review queue.",
      };
    }
    case "record.corrected":
      return {
        icon: <PencilLine className="h-4 w-4" />,
        title: "Fields corrected",
        detail: text(detail["fields"])
          ? `Changed ${text(detail["fields"])}.`
          : "A person edited the extracted fields.",
      };
    case "record.rejected":
      return {
        icon: <XCircle className="h-4 w-4" />,
        title: "Record rejected",
        detail: text(detail["reason"]) || "Rejected during review.",
      };
    case "record.held":
      return {
        icon: <PauseCircle className="h-4 w-4" />,
        title: "Record put on hold",
        detail: text(detail["note"]) || "Waiting on more information.",
      };
    case "record.post_failed":
      return {
        icon: <AlertTriangle className="h-4 w-4" />,
        title: `Write to ${destination || "destination"} failed`,
        detail: text(detail["error"]) || "The destination did not accept the record.",
      };
    case "document.needs_attention":
      return {
        icon: <FileWarning className="h-4 w-4" />,
        title: `Held ${text(detail["filename"]) || "a document"}`,
        detail: text(detail["reason"]) || "The file did not produce readable text.",
      };
    case "settings.updated":
      return {
        icon: <Settings className="h-4 w-4" />,
        title: "Workspace settings updated",
        detail: "Autonomy, thresholds or limits changed.",
      };
    case "connection.reconnected":
      return {
        icon: <RefreshCw className="h-4 w-4" />,
        title: "Google Sheets reconnected",
        detail: "The sheet connection was refreshed.",
      };
    default:
      return {
        icon: <FileSpreadsheet className="h-4 w-4" />,
        title: row.action.replace(/[._]/g, " "),
        detail: "",
      };
  }
}

function ActivityPage() {
  const activity = useQuery({ queryKey: ["activity"], queryFn: () => activityFn() });
  const [detailId, setDetailId] = useState<string | null>(null);
  const rows = activity.data?.activity ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Activity"
        title="Every read, decision and write"
        description="A complete record of what Bahi did, what a person changed, and what was written to each destination."
        actions={
          <button
            type="button"
            onClick={() => void activity.refetch()}
            className="btn-outline h-9 px-4 text-xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${activity.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </button>
        }
      />

      {activity.isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length ? (
        <ol className="space-y-2">
          {rows.map((row) => {
            const info = describe(row);
            const body = (
              <>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
                  {info.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{info.title}</p>
                  {info.detail ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">{info.detail}</p>
                  ) : null}
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {formatDateTime(row.createdAt)}
                    {row.actor ? ` · ${row.actor}` : ""}
                  </p>
                </div>
              </>
            );
            return (
              <li key={row.id}>
                {row.recordId ? (
                  <button
                    type="button"
                    onClick={() => setDetailId(row.recordId)}
                    className="flex w-full items-start gap-3 rounded-2xl border border-border bg-card p-3.5 text-left transition-colors hover:border-foreground/20"
                  >
                    {body}
                  </button>
                ) : (
                  <div className="flex items-start gap-3 rounded-2xl border border-border bg-card p-3.5">
                    {body}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="rounded-2xl border border-border bg-card p-10 text-center">
          <p className="text-base font-semibold">No activity yet</p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
            Send your first document or run a sample, and the trail starts here.
          </p>
        </div>
      )}

      <RecordDetail
        recordId={detailId}
        open={Boolean(detailId)}
        onOpenChange={(open) => !open && setDetailId(null)}
      />
    </div>
  );
}
