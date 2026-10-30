import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, Download, Inbox, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/app/page-header";
import { RecordCard } from "@/components/app/record-card";
import { RecordDetail } from "@/components/app/record-detail";
import { DOC_TYPE_LABELS, formatINR } from "@/lib/format";
import type { Destination, DocType, RecordRow } from "@/lib/types";
import { bulkActionFn, exportExcelFn, queueFn, recordActionFn } from "@/lib/api";

const STATUS_OPTIONS = [
  { value: "open", label: "Waiting for review" },
  { value: "pending_review", label: "Needs review" },
  { value: "held", label: "On hold" },
  { value: "posted", label: "Posted to Tally" },
  { value: "written", label: "Written to sheets" },
  { value: "rejected", label: "Rejected" },
  { value: "failed", label: "Failed" },
] as const;

type StatusFilter = (typeof STATUS_OPTIONS)[number]["value"];

const REASON_OPTIONS = [
  { value: "all", label: "All reasons" },
  { value: "fail", label: "Failed a check" },
  { value: "warn", label: "Warning only" },
  { value: "confidence", label: "Low confidence" },
  { value: "unassigned", label: "Unassigned" },
  { value: "overdue", label: "Overdue" },
] as const;

type ReasonFilter = (typeof REASON_OPTIONS)[number]["value"];

const DESTINATION_OPTIONS: { value: Destination | "all"; label: string }[] = [
  { value: "all", label: "All destinations" },
  { value: "tally", label: "TallyPrime" },
  { value: "excel", label: "Excel" },
  { value: "google_sheets", label: "Google Sheets" },
];

export const Route = createFileRoute("/app/queue")({
  head: () => ({ meta: [{ title: "Review queue — Bahi" }] }),
  component: QueuePage,
});

function saveBase64(filename: string, base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function QueuePage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<StatusFilter>("open");
  const [docType, setDocType] = useState<DocType | "all">("all");
  const [destination, setDestination] = useState<Destination | "all">("all");
  const [reason, setReason] = useState<ReasonFilter>("all");
  const [assignee, setAssignee] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const queue = useQuery({
    queryKey: ["queue", status, docType, destination, reason, assignee],
    queryFn: () =>
      queueFn({
        data: {
          status,
          ...(docType !== "all" ? { docType } : {}),
          ...(destination !== "all" ? { destination } : {}),
          ...(reason !== "all" ? { reason } : {}),
          ...(assignee !== "all" ? { assignedTo: assignee } : {}),
        },
      }),
  });

  const records = (queue.data?.records ?? []).filter((record) => {
    if (!search.trim()) return true;
    const needle = search.trim().toLowerCase();
    return (
      record.title.toLowerCase().includes(needle) ||
      String(record.fields.vendor_name ?? "")
        .toLowerCase()
        .includes(needle) ||
      String(record.fields.invoice_number ?? "")
        .toLowerCase()
        .includes(needle)
    );
  });

  const metrics = queue.data?.metrics;
  const members = queue.data?.members ?? [];
  const total = records.reduce((sum, record) => sum + record.amountMinor, 0);
  const visibleSelected = records.filter((record) => selected.has(record.id));

  function toggleSelected(id: string, next: boolean) {
    setSelected((current) => {
      const copy = new Set(current);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  }

  async function bulk(action: "approve" | "reject" | "hold") {
    if (!visibleSelected.length) return;
    setBulkBusy(true);
    try {
      const result = await bulkActionFn({
        data: {
          recordIds: visibleSelected.map((record) => record.id),
          action,
          ...(action === "reject" ? { reason: "Rejected in bulk from the review queue." } : {}),
        },
      });
      toast.success(
        `${result.succeeded.length} record${result.succeeded.length === 1 ? "" : "s"} ${
          action === "approve" ? "processed" : action === "reject" ? "rejected" : "held"
        }${result.failed.length ? ` · ${result.failed.length} failed` : ""}.`,
      );
      if (result.failed.length) {
        toast.error(result.failed[0]!.message);
      }
      setSelected(new Set());
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The bulk action did not go through.");
    } finally {
      setBulkBusy(false);
    }
  }

  async function approve(record: RecordRow) {
    setBusyId(record.id);
    try {
      const result = await recordActionFn({
        data: { recordId: record.id, action: "approve", destination: record.destination },
      });
      toast.success(
        result.status === "posted" || result.status === "written"
          ? `Entered as ${result.destinationRef ?? "record"}.`
          : "Approved and queued for writing.",
      );
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not approve that record.");
    } finally {
      setBusyId(null);
    }
  }

  async function exportExcel() {
    if (!records.length) return;
    setExporting(true);
    try {
      const file = await exportExcelFn({ data: { recordIds: records.map((record) => record.id) } });
      saveBase64(file.filename, file.base64);
      toast.success(`Exported ${file.count} record${file.count === 1 ? "" : "s"}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not build the workbook.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Review queue"
        title="What needs a person"
        description="Every record Bahi would not post on its own. Approve to re-run the checks and write it, or open the record to correct the fields first."
        actions={
          <>
            <button
              type="button"
              onClick={() => void queue.refetch()}
              className="btn-outline h-9 px-4 text-xs"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${queue.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </button>
            <button
              type="button"
              onClick={exportExcel}
              disabled={exporting || !records.length}
              className="btn-primary h-9 px-4 text-xs"
            >
              <Download className="h-3.5 w-3.5" />
              {exporting ? "Building…" : "Export Excel"}
            </button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: "Waiting", value: queue.data?.counts.pending ?? 0 },
          { label: "Unassigned", value: metrics?.unassigned ?? 0 },
          { label: "Overdue", value: metrics?.overdue ?? 0, alert: (metrics?.overdue ?? 0) > 0 },
          { label: "Due today", value: metrics?.dueToday ?? 0 },
          {
            label: "Median age",
            value: metrics?.medianAgeHours === null ? "—" : `${metrics?.medianAgeHours ?? 0}h`,
          },
          { label: "Exceptions", value: queue.data?.counts.exceptions ?? 0 },
        ].map((item) => (
          <div key={item.label} className="rounded-2xl border border-border bg-card px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {item.label}
            </p>
            <p
              className={`mt-1 text-2xl font-semibold tracking-tight ${
                "alert" in item && item.alert ? "text-destructive" : ""
              }`}
            >
              {item.value}
            </p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as StatusFilter)}
          className="h-9 rounded-full border border-border bg-card px-3 text-xs outline-none"
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          value={docType}
          onChange={(event) => setDocType(event.target.value as DocType | "all")}
          className="h-9 rounded-full border border-border bg-card px-3 text-xs outline-none"
        >
          <option value="all">All document types</option>
          {(Object.keys(DOC_TYPE_LABELS) as DocType[]).map((key) => (
            <option key={key} value={key}>
              {DOC_TYPE_LABELS[key]}
            </option>
          ))}
        </select>
        <select
          value={destination}
          onChange={(event) => setDestination(event.target.value as Destination | "all")}
          className="h-9 rounded-full border border-border bg-card px-3 text-xs outline-none"
        >
          {DESTINATION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          value={reason}
          onChange={(event) => setReason(event.target.value as ReasonFilter)}
          className="h-9 rounded-full border border-border bg-card px-3 text-xs outline-none"
        >
          {REASON_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          value={assignee}
          onChange={(event) => setAssignee(event.target.value)}
          className="h-9 rounded-full border border-border bg-card px-3 text-xs outline-none"
        >
          <option value="all">Anyone</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search vendor or document number"
          className="h-9 min-w-56 flex-1 rounded-full border border-border bg-card px-4 text-xs outline-none placeholder:text-muted-foreground"
        />
        <span className="text-xs text-muted-foreground">
          {records.length} record{records.length === 1 ? "" : "s"} · {formatINR(total)}
        </span>
      </div>

      {visibleSelected.length ? (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card px-4 py-3">
          <span className="flex items-center gap-2 text-xs font-medium">
            <CheckCheck className="h-4 w-4" />
            {visibleSelected.length} selected ·{" "}
            {formatINR(visibleSelected.reduce((sum, record) => sum + record.amountMinor, 0))}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="btn-outline h-8 px-3 text-xs"
              disabled={bulkBusy}
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => void bulk("hold")}
              disabled={bulkBusy}
              className="btn-outline h-8 px-3 text-xs"
            >
              Hold
            </button>
            <button
              type="button"
              onClick={() => void bulk("reject")}
              disabled={bulkBusy}
              className="btn-outline h-8 px-3 text-xs"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={() => void bulk("approve")}
              disabled={bulkBusy}
              className="btn-primary h-8 px-4 text-xs"
            >
              {bulkBusy ? "Working…" : "Approve & enter"}
            </button>
          </div>
        </div>
      ) : null}

      {queue.isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : queue.isError ? (
        <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Could not load the queue. Refresh to try again.
        </div>
      ) : records.length ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {records.map((record) => (
            <RecordCard
              key={record.id}
              record={record}
              onOpen={setDetailId}
              selectable={record.status === "pending_review" || record.status === "held"}
              selected={selected.has(record.id)}
              onSelect={toggleSelected}
              actions={
                record.status === "pending_review" || record.status === "held" ? (
                  <button
                    type="button"
                    onClick={() => approve(record)}
                    disabled={busyId === record.id}
                    className="rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-foreground/85 disabled:opacity-50"
                  >
                    {busyId === record.id ? "Writing…" : "Approve"}
                  </button>
                ) : null
              }
            />
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border border-border bg-card p-10 text-center">
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-secondary">
            <Inbox className="h-5 w-5" />
          </span>
          <p className="mt-4 text-base font-semibold">Nothing in this view</p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
            Records appear here when they need a decision. Try a different filter, or send a
            document from the conversation.
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
