import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  MinusCircle,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { DestinationBadge, StatusBadge } from "@/components/app/status-badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  DOC_TYPE_LABELS,
  DESTINATION_LABELS,
  formatAmount,
  formatDateTime,
  formatINR,
  outcomeLabel,
} from "@/lib/format";
import type { Destination, RecordRow } from "@/lib/types";
import {
  answerReviewFn,
  assignRecordFn,
  destinationPreviewFn,
  documentUrlFn,
  exportExcelFn,
  recordActionFn,
  recordDetailFn,
  requestReviewFn,
  reverseEntryFn,
  saveFieldsFn,
  tallyXmlFn,
} from "@/lib/api";

const EDITABLE: { key: string; label: string; type?: string }[] = [
  { key: "vendor_name", label: "Vendor name" },
  { key: "vendor_gstin", label: "Vendor GSTIN" },
  { key: "invoice_number", label: "Document number" },
  { key: "invoice_date", label: "Document date", type: "date" },
  { key: "place_of_supply", label: "Place of supply" },
  { key: "taxable_value", label: "Taxable value", type: "number" },
  { key: "cgst", label: "CGST", type: "number" },
  { key: "sgst", label: "SGST", type: "number" },
  { key: "igst", label: "IGST", type: "number" },
  { key: "total", label: "Total", type: "number" },
  { key: "tds_section", label: "TDS section" },
  { key: "narration", label: "Narration" },
];

const inputClass =
  "h-10 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-foreground/30 focus:ring-2 focus:ring-foreground/10";

const AGENT_LABELS: Record<string, string> = {
  document_classifier: "Document classifier",
  extraction: "Extraction",
  master_matcher: "Supplier matcher",
  validation_explainer: "Validation explainer",
  bank_categoriser: "Bank categoriser",
  destination_mapper: "Sheet mapper",
};

function OutcomeIcon({ outcome }: { outcome: string }) {
  if (outcome === "pass") return <CheckCircle2 className="h-4 w-4 shrink-0 text-foreground/70" />;
  if (outcome === "warn") return <AlertTriangle className="h-4 w-4 shrink-0 text-foreground/50" />;
  if (outcome === "fail") return <XCircle className="h-4 w-4 shrink-0 text-destructive" />;
  return <MinusCircle className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

function download(filename: string, bytes: BlobPart, type: string) {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function RecordDetail({
  recordId,
  open,
  onOpenChange,
}: {
  recordId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [destination, setDestination] = useState<Destination>("tally");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [assigneeId, setAssigneeId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [requestKind, setRequestKind] = useState<"document" | "clarification">("document");
  const [requestMessage, setRequestMessage] = useState("");
  const [answerText, setAnswerText] = useState("");

  const detail = useQuery({
    queryKey: ["record", recordId],
    queryFn: () => recordDetailFn({ data: { recordId: recordId ?? "" } }),
    enabled: open && Boolean(recordId),
  });

  const preview = useQuery({
    queryKey: ["record-preview", recordId],
    queryFn: () => destinationPreviewFn({ data: { recordId: recordId ?? "" } }),
    enabled: open && Boolean(recordId),
  });

  const record = detail.data?.record ?? null;
  const members = detail.data?.members ?? [];
  const requests = detail.data?.requests ?? [];

  useEffect(() => {
    if (!record) return;
    setDestination(record.destination);
    const next: Record<string, string> = {};
    for (const field of EDITABLE) {
      const value = record.fields[field.key];
      next[field.key] = value === undefined || value === null ? "" : String(value);
    }
    setDraft(next);
    setAssigneeId(record.assignedTo ?? "");
    setDueDate(record.dueAt ? record.dueAt.slice(0, 10) : "");
    // Reseed only when the saved record changes; depending on the whole object
    // would wipe in-progress edits on every background refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.id, record?.updatedAt]);

  async function refresh() {
    await queryClient.invalidateQueries();
  }

  async function act(action: "approve" | "reject" | "hold") {
    if (!record) return;
    setBusy(action);
    try {
      const result = await recordActionFn({
        data: {
          recordId: record.id,
          action,
          ...(action === "approve" ? { destination } : {}),
          ...(action === "reject" && reason.trim() ? { reason: reason.trim() } : {}),
        },
      });
      toast.success(
        action === "approve"
          ? result.status === "posted" || result.status === "written"
            ? `Entered as ${result.destinationRef ?? "record"}.`
            : "Approved and queued for writing."
          : action === "hold"
            ? "Moved to hold."
            : "Rejected.",
      );
      setReason("");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That action did not go through.");
    } finally {
      setBusy(null);
    }
  }

  async function reverse() {
    if (!record) return;
    if (
      !window.confirm(
        record.destination === "tally"
          ? "Queue a cancellation in Tally for this voucher?"
          : "Remove this row from the Google Sheet?",
      )
    ) {
      return;
    }
    setBusy("reverse");
    try {
      const result = await reverseEntryFn({ data: { recordId: record.id } });
      toast.success(result.message);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The entry could not be reversed.");
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!record) return;
    setBusy("save");
    try {
      await saveFieldsFn({ data: { recordId: record.id, fields: draft } });
      toast.success("Fields saved and checks re-run.");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the fields.");
    } finally {
      setBusy(null);
    }
  }

  async function saveAssignment() {
    if (!record) return;
    setBusy("assign");
    try {
      await assignRecordFn({
        data: {
          recordId: record.id,
          userId: assigneeId || null,
          dueAt: dueDate ? new Date(`${dueDate}T09:00:00`).toISOString() : null,
        },
      });
      toast.success(assigneeId ? "Assignment saved." : "Assignment cleared.");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the assignment.");
    } finally {
      setBusy(null);
    }
  }

  async function requestInput() {
    if (!record) return;
    if (!requestMessage.trim()) {
      toast.error("Write what you need from the person first.");
      return;
    }
    setBusy("request");
    try {
      await requestReviewFn({
        data: { recordId: record.id, kind: requestKind, message: requestMessage.trim() },
      });
      toast.success(requestKind === "document" ? "Document requested." : "Question sent.");
      setRequestMessage("");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send the request.");
    } finally {
      setBusy(null);
    }
  }

  async function answerRequest(requestId: string) {
    if (!answerText.trim()) {
      toast.error("Write an answer first.");
      return;
    }
    setBusy(`answer:${requestId}`);
    try {
      await answerReviewFn({ data: { requestId, answer: answerText.trim() } });
      toast.success("Answer recorded.");
      setAnswerText("");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the answer.");
    } finally {
      setBusy(null);
    }
  }

  async function openDocument() {
    if (!record?.document) return;
    setBusy("document");
    try {
      const { url } = await documentUrlFn({ data: { documentId: record.document.id } });
      if (url) window.open(url, "_blank", "noopener");
      else toast.error("No stored file for this record.");
    } catch {
      toast.error("Could not open the source document.");
    } finally {
      setBusy(null);
    }
  }

  async function downloadTally() {
    if (!record) return;
    setBusy("tally");
    try {
      const { filename, xml } = await tallyXmlFn({ data: { recordId: record.id } });
      download(filename, xml, "application/xml");
    } catch {
      toast.error("Could not build the Tally XML.");
    } finally {
      setBusy(null);
    }
  }

  async function downloadExcel() {
    if (!record) return;
    setBusy("excel");
    try {
      const file = await exportExcelFn({ data: { recordIds: [record.id] } });
      const binary = atob(file.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      download(
        file.filename,
        bytes,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
    } catch {
      toast.error("Could not build the Excel workbook.");
    } finally {
      setBusy(null);
    }
  }

  const isOpenRecord = record?.status === "pending_review" || record?.status === "held";
  const lineItems = Array.isArray(record?.fields.line_items) ? record.fields.line_items : [];
  const reading = record?.envelope;
  const evidence = record?.evidence ?? {};
  const evidenceNotes: string[] = [];
  if (typeof evidence.poMatched === "boolean") {
    evidenceNotes.push(
      evidence.poMatched
        ? `Linked to purchase order${evidence.poNumber ? ` ${evidence.poNumber}` : ""}.`
        : String(evidence.poReason ?? "No matching purchase order was found."),
    );
  }
  if (typeof evidence.grMatched === "boolean") {
    evidenceNotes.push(
      evidence.grMatched
        ? "Goods receipt found and the quantities agree."
        : String(evidence.grReason ?? "No matching goods receipt was found."),
    );
  }
  if (evidence.gstr2bMatch === "matched") {
    evidenceNotes.push(
      `Found in GSTR-2B${evidence.gstr2bPeriod ? ` for ${evidence.gstr2bPeriod}` : ""}.`,
    );
  } else if (evidence.gstr2bMatch === "mismatch") {
    evidenceNotes.push(
      `Amount differs from GSTR-2B${evidence.gstr2bPeriod ? ` for ${evidence.gstr2bPeriod}` : ""} — check before claiming ITC.`,
    );
  } else if (evidence.gstr2bMatch === "not_in_2b") {
    evidenceNotes.push("This invoice is not in the imported GSTR-2B.");
  } else if (evidence.gstr2bMatch === "missing_in_books") {
    evidenceNotes.push("This bill appears in GSTR-2B but no matching invoice is in your books.");
  }
  if (evidence.gstinStatus) {
    evidenceNotes.push(
      `GSTIN status: ${evidence.gstinStatus}${evidence.gstinName ? ` · ${evidence.gstinName}` : ""}.`,
    );
  }
  const hasReading = Boolean(
    record &&
    (record.agentMode ||
      reading?.escalated ||
      reading?.match ||
      reading?.reason ||
      reading?.explanations?.length ||
      reading?.warnings?.length ||
      reading?.agents?.length ||
      evidenceNotes.length),
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto border-l border-border bg-background p-0 sm:max-w-2xl">
        {detail.isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !record ? (
          <div className="p-6 text-sm text-muted-foreground">Record not found.</div>
        ) : (
          <div className="pb-10">
            <SheetHeader className="border-b border-border px-6 py-5 text-left">
              <div className="flex flex-wrap items-center gap-2">
                <SheetTitle className="text-lg font-semibold">{record.title}</SheetTitle>
                <StatusBadge status={record.status} />
                <DestinationBadge destination={record.destination} />
              </div>
              <SheetDescription className="text-xs text-muted-foreground">
                {DOC_TYPE_LABELS[record.docType]} · {formatINR(record.amountMinor)} ·{" "}
                {Math.round(record.overallConfidence * 100)}% confidence
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-7 px-6 py-6">
              {isOpenRecord ? (
                <section className="rounded-2xl border border-border bg-card p-4">
                  <p className="text-sm font-semibold">Decision</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Approving re-runs the checks and writes to the destination when everything
                    passes.
                  </p>
                  {record.reason ? (
                    <p className="mt-3 rounded-xl bg-muted/60 px-3 py-2.5 text-xs text-foreground/80">
                      {record.reason}
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <select
                      value={destination}
                      onChange={(event) => setDestination(event.target.value as Destination)}
                      className={`${inputClass} h-9 w-auto`}
                    >
                      {(Object.keys(DESTINATION_LABELS) as Destination[]).map((key) => (
                        <option key={key} value={key}>
                          {DESTINATION_LABELS[key]}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => act("approve")}
                      disabled={busy !== null}
                      className="btn-primary h-9 px-4 text-xs"
                    >
                      {busy === "approve" ? "Writing…" : "Approve & enter"}
                    </button>
                    <button
                      type="button"
                      onClick={() => act("hold")}
                      disabled={busy !== null}
                      className="btn-outline h-9 px-4 text-xs"
                    >
                      {busy === "hold" ? "Holding…" : "Hold"}
                    </button>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <input
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="Reason for rejecting (optional)"
                      className={`${inputClass} h-9 flex-1`}
                    />
                    <button
                      type="button"
                      onClick={() => act("reject")}
                      disabled={busy !== null}
                      className="btn-outline h-9 px-4 text-xs"
                    >
                      {busy === "reject" ? "Rejecting…" : "Reject"}
                    </button>
                  </div>
                </section>
              ) : (
                <section className="rounded-2xl border border-border bg-card p-4 text-sm">
                  <p className="font-medium">
                    {record.status === "posted" || record.status === "written"
                      ? `Entered in ${DESTINATION_LABELS[record.destination]} as ${record.destinationRef ?? "—"}.`
                      : (record.reason ?? "No further action needed.")}
                  </p>
                  {record.postedAt ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Posted {formatDateTime(record.postedAt)}
                    </p>
                  ) : null}
                  {record.status === "posted" || record.status === "written" ? (
                    <button
                      type="button"
                      onClick={reverse}
                      disabled={busy !== null}
                      className="btn-outline mt-3 h-9 px-4 text-xs"
                    >
                      {busy === "reverse" ? "Reversing…" : "Reverse entry"}
                    </button>
                  ) : null}
                </section>
              )}

              {isOpenRecord ? (
                <>
                  <section className="rounded-2xl border border-border bg-card p-4">
                    <p className="text-sm font-semibold">Who is on this</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {record.assignedToName
                        ? `Assigned to ${record.assignedToName}${record.dueAt ? ` · due ${formatDateTime(record.dueAt)}` : ""}.`
                        : "Nobody is assigned yet."}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <select
                        value={assigneeId}
                        onChange={(event) => setAssigneeId(event.target.value)}
                        className={`${inputClass} h-9 w-auto`}
                      >
                        <option value="">Unassigned</option>
                        {members
                          .filter((member) => member.role !== "viewer")
                          .map((member) => (
                            <option key={member.id} value={member.id}>
                              {member.name}
                            </option>
                          ))}
                      </select>
                      <input
                        type="date"
                        value={dueDate}
                        onChange={(event) => setDueDate(event.target.value)}
                        className={`${inputClass} h-9 w-auto`}
                      />
                      <button
                        type="button"
                        onClick={saveAssignment}
                        disabled={busy !== null}
                        className="btn-outline h-9 px-4 text-xs"
                      >
                        {busy === "assign" ? "Saving…" : "Save assignment"}
                      </button>
                    </div>
                  </section>

                  <section className="rounded-2xl border border-border bg-card p-4">
                    <p className="text-sm font-semibold">Ask for more</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Hold this record and ask the vendor or your team for a missing document or a
                      clarification.
                    </p>
                    {requests.length ? (
                      <ul className="mt-3 space-y-2">
                        {requests.map((request) => (
                          <li
                            key={request.id}
                            className="rounded-xl bg-muted/60 px-3 py-2.5 text-xs"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-medium capitalize">
                                {request.kind} · {request.status}
                              </span>
                              <span className="text-muted-foreground">
                                {formatDateTime(request.createdAt)}
                              </span>
                            </div>
                            <p className="mt-1">{request.message}</p>
                            <p className="mt-1 text-muted-foreground">
                              Asked by {request.requestedByName ?? "someone"}
                            </p>
                            {request.answer ? (
                              <p className="mt-2 rounded-lg bg-background px-2.5 py-2">
                                {request.answer}
                                <span className="mt-1 block text-[10px] text-muted-foreground">
                                  Answered by {request.answeredByName ?? "someone"}
                                  {request.answeredAt
                                    ? ` · ${formatDateTime(request.answeredAt)}`
                                    : ""}
                                </span>
                              </p>
                            ) : request.status === "open" ? (
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <input
                                  value={answerText}
                                  onChange={(event) => setAnswerText(event.target.value)}
                                  placeholder="Answer"
                                  className={`${inputClass} h-8 flex-1`}
                                />
                                <button
                                  type="button"
                                  onClick={() => void answerRequest(request.id)}
                                  disabled={busy !== null}
                                  className="btn-outline h-8 px-3 text-xs"
                                >
                                  {busy === `answer:${request.id}` ? "Saving…" : "Answer"}
                                </button>
                              </div>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <select
                        value={requestKind}
                        onChange={(event) =>
                          setRequestKind(event.target.value as "document" | "clarification")
                        }
                        className={`${inputClass} h-9 w-auto`}
                      >
                        <option value="document">Request document</option>
                        <option value="clarification">Ask a question</option>
                      </select>
                      <input
                        value={requestMessage}
                        onChange={(event) => setRequestMessage(event.target.value)}
                        placeholder="What do you need?"
                        className={`${inputClass} h-9 flex-1`}
                      />
                      <button
                        type="button"
                        onClick={requestInput}
                        disabled={busy !== null}
                        className="btn-outline h-9 px-4 text-xs"
                      >
                        {busy === "request" ? "Sending…" : "Send request"}
                      </button>
                    </div>
                  </section>
                </>
              ) : null}

              {hasReading ? (
                <section className="rounded-2xl border border-border bg-card p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold">How Bahi read this</p>
                    {record.agentMode ? (
                      <span className="rounded-full bg-muted px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {record.agentMode === "model" ? "AI agents" : "Rule engine"}
                      </span>
                    ) : null}
                  </div>

                  {record.envelope.escalated ? (
                    <p className="mt-3 rounded-xl bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
                      An agent step failed on this document, so a person needs to check it. Nothing
                      was written automatically.
                    </p>
                  ) : null}

                  {record.envelope.match ? (
                    <div className="mt-3 rounded-xl bg-muted/60 px-3 py-2.5">
                      <p className="text-xs font-semibold">
                        Supplier ·{" "}
                        {record.envelope.match.status === "matched"
                          ? "matched"
                          : record.envelope.match.status === "ambiguous"
                            ? "needs confirmation"
                            : "new party"}
                        <span className="ml-2 font-normal text-muted-foreground">
                          {Math.round(record.envelope.match.confidence * 100)}% sure
                        </span>
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {record.envelope.match.reason}
                      </p>
                    </div>
                  ) : null}

                  {evidenceNotes.length ? (
                    <ul className="mt-3 space-y-1">
                      {evidenceNotes.map((note) => (
                        <li key={note} className="text-xs text-muted-foreground">
                          · {note}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {record.envelope.reason ? (
                    <p className="mt-3 text-xs text-muted-foreground">{record.envelope.reason}</p>
                  ) : null}

                  {record.envelope.explanations?.length ? (
                    <ul className="mt-3 space-y-2">
                      {record.envelope.explanations.map((item) => (
                        <li key={`${item.ruleId}-${item.outcome}`} className="text-xs">
                          <p className="font-medium">{item.reason}</p>
                          <p className="text-muted-foreground">{item.nextStep}</p>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {record.envelope.warnings?.length ? (
                    <ul className="mt-3 space-y-1">
                      {record.envelope.warnings.map((warning) => (
                        <li key={warning} className="text-xs text-muted-foreground">
                          · {warning}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {record.envelope.agents?.length ? (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {record.envelope.agents.map((agent) => (
                        <span
                          key={agent}
                          className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground"
                        >
                          {AGENT_LABELS[agent] ?? agent.replace(/_/g, " ")}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </section>
              ) : null}

              <section>
                <p className="text-sm font-semibold">Checks</p>
                <ul className="mt-3 space-y-2">
                  {record.validation.map((rule) => (
                    <li
                      key={rule.id}
                      className="flex gap-3 rounded-xl border border-border bg-card px-3.5 py-3"
                    >
                      <OutcomeIcon outcome={rule.outcome} />
                      <div>
                        <p className="text-xs font-semibold">
                          {rule.label}
                          <span className="ml-2 font-normal text-muted-foreground">
                            {outcomeLabel(rule.outcome)}
                          </span>
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{rule.message}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold">Fields</p>
                  <button
                    type="button"
                    onClick={save}
                    disabled={busy !== null}
                    className="btn-outline h-8 px-3 text-xs"
                  >
                    {busy === "save" ? "Saving…" : "Save fields"}
                  </button>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {EDITABLE.map((field) => {
                    const location = record.locations[field.key];
                    const where = [
                      location?.page ? `Page ${location.page}` : null,
                      location?.hint ?? null,
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <label key={field.key} className="block">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          {field.label}
                        </span>
                        <input
                          type={field.type ?? "text"}
                          value={draft[field.key] ?? ""}
                          onChange={(event) =>
                            setDraft((current) => ({ ...current, [field.key]: event.target.value }))
                          }
                          className={`${inputClass} mt-1`}
                        />
                        {where ? (
                          <span className="mt-1 block text-[10px] text-muted-foreground">
                            From {where}
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
              </section>

              {lineItems.length ? (
                <section>
                  <p className="text-sm font-semibold">Line items</p>
                  <div className="mt-3 overflow-hidden rounded-xl border border-border">
                    <table className="w-full text-xs">
                      <thead className="bg-muted text-left text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 font-semibold">Description</th>
                          <th className="px-3 py-2 font-semibold">HSN</th>
                          <th className="px-3 py-2 text-right font-semibold">Qty</th>
                          <th className="px-3 py-2 text-right font-semibold">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lineItems.map((item, index) => (
                          <tr
                            key={`${item.description}-${index}`}
                            className="border-t border-border"
                          >
                            <td className="px-3 py-2">{item.description}</td>
                            <td className="px-3 py-2 text-muted-foreground">{item.hsn ?? "—"}</td>
                            <td className="px-3 py-2 text-right">{item.quantity ?? "—"}</td>
                            <td className="px-3 py-2 text-right">
                              {formatINR(Math.round((item.amount ?? 0) * 100), 2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ) : null}

              <section>
                <p className="text-sm font-semibold">Source</p>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-3.5 py-3">
                  <div className="flex items-center gap-2.5">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="text-xs font-medium">
                        {record.document?.filename ?? "Typed in chat"}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {record.document
                          ? [
                              record.document.status.replace("_", " "),
                              record.document.renderMode === "vision"
                                ? "read from photo by vision"
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")
                          : "No file attached"}
                      </p>
                    </div>
                  </div>
                  {record.document ? (
                    <button
                      type="button"
                      onClick={openDocument}
                      disabled={busy !== null}
                      className="btn-outline h-8 px-3 text-xs"
                    >
                      {busy === "document" ? "Opening…" : "View file"}
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              </section>

              {preview.data?.payload ? (
                <section>
                  <p className="text-sm font-semibold">What gets written</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Exactly what Bahi will hand to {DESTINATION_LABELS[record.destination]} when
                    this record is approved.
                  </p>
                  {"entries" in preview.data.payload ? (
                    <div className="mt-3 overflow-hidden rounded-xl border border-border">
                      <p className="bg-muted px-3 py-2 text-xs font-medium">
                        {preview.data.payload.voucherType} · {preview.data.payload.date} ·{" "}
                        {preview.data.payload.party}
                      </p>
                      <table className="w-full text-xs">
                        <thead className="text-left text-muted-foreground">
                          <tr>
                            <th className="px-3 py-2 font-semibold">Ledger</th>
                            <th className="px-3 py-2 font-semibold">Side</th>
                            <th className="px-3 py-2 text-right font-semibold">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.data.payload.entries.map((entry, index) => (
                            <tr key={`${entry.ledger}-${index}`} className="border-t border-border">
                              <td className="px-3 py-2">{entry.ledger}</td>
                              <td className="px-3 py-2 capitalize text-muted-foreground">
                                {entry.direction}
                              </td>
                              <td className="px-3 py-2 text-right">{formatAmount(entry.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="mt-3 overflow-hidden rounded-xl border border-border">
                      <table className="w-full text-xs">
                        <tbody>
                          {Object.entries(preview.data.payload).map(([key, value]) => (
                            <tr key={key} className="border-b border-border last:border-0">
                              <td className="px-3 py-2 capitalize text-muted-foreground">
                                {key.replace(/([A-Z])/g, " $1").replace(/_/g, " ")}
                              </td>
                              <td className="px-3 py-2 text-right font-medium">
                                {typeof value === "number" ? formatAmount(value) : String(value)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              ) : null}

              <section>
                <p className="text-sm font-semibold">Downloads</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={downloadTally}
                    disabled={busy !== null}
                    className="btn-outline h-9 px-4 text-xs"
                  >
                    <Download className="h-3.5 w-3.5" />
                    {busy === "tally" ? "Building…" : "Tally voucher XML"}
                  </button>
                  <button
                    type="button"
                    onClick={downloadExcel}
                    disabled={busy !== null}
                    className="btn-outline h-9 px-4 text-xs"
                  >
                    <Download className="h-3.5 w-3.5" />
                    {busy === "excel" ? "Building…" : "This record as Excel"}
                  </button>
                </div>
              </section>

              <section>
                <p className="text-sm font-semibold">Posting history</p>
                {detail.data?.posts.length ? (
                  <ul className="mt-3 space-y-2">
                    {detail.data.posts.map((post) => (
                      <li
                        key={post.id}
                        className="rounded-xl border border-border bg-card px-3.5 py-3 text-xs"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium">
                            {DESTINATION_LABELS[post.destination]} · {post.status}
                          </span>
                          <span className="text-muted-foreground">
                            {formatDateTime(post.createdAt)}
                          </span>
                        </div>
                        <p className="mt-1 text-muted-foreground">
                          {post.externalRef ? `Reference ${post.externalRef}` : "No reference yet"}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">Nothing written yet.</p>
                )}
                <p className="mt-4 text-[11px] text-muted-foreground">
                  Idempotency key: <span className="font-mono">{record.idempotencyKey}</span>
                </p>
              </section>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
