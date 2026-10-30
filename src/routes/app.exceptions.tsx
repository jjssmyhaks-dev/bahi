import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, FileWarning, Loader2, MessageSquare, RefreshCw } from "lucide-react";

import { PageHeader } from "@/components/app/page-header";
import { DOC_TYPE_LABELS, formatDateTime } from "@/lib/format";
import { exceptionsFn } from "@/lib/api";

export const Route = createFileRoute("/app/exceptions")({
  head: () => ({ meta: [{ title: "Exceptions — Bahi" }] }),
  component: ExceptionsPage,
});

function ExceptionsPage() {
  const exceptions = useQuery({ queryKey: ["exceptions"], queryFn: () => exceptionsFn() });
  const documents = exceptions.data?.documents ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Exceptions"
        title="Documents that could not be read"
        description="Scans and photos without readable text, password-protected files, or formats Bahi does not open yet. Nothing is guessed — the file is held here with the reason."
        actions={
          <button
            type="button"
            onClick={() => void exceptions.refetch()}
            className="btn-outline h-9 px-4 text-xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${exceptions.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </button>
        }
      />

      {exceptions.isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : documents.length ? (
        <div className="space-y-3">
          {documents.map((document) => (
            <article key={document.id} className="rounded-2xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
                    <FileWarning className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold">{document.filename}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {document.docType ? DOC_TYPE_LABELS[document.docType] : "Unknown type"} ·{" "}
                      {formatDateTime(document.createdAt)}
                    </p>
                  </div>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-1 text-[11px] font-semibold text-destructive">
                  <AlertTriangle className="h-3 w-3" />
                  {document.status === "failed" ? "Failed" : "Needs attention"}
                </span>
              </div>
              <p className="mt-3 rounded-xl bg-muted/60 px-3 py-2.5 text-xs text-foreground/80">
                {document.error ?? "The document did not produce readable text."}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {document.chatId ? (
                  <Link
                    to="/app"
                    search={{ chat: document.chatId }}
                    className="btn-outline h-8 px-3 text-xs"
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    Open conversation
                  </Link>
                ) : null}
                <span className="text-[11px] text-muted-foreground">
                  Try a text-based PDF, an Excel/CSV export, or paste the details as a message.
                </span>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border border-border bg-card p-10 text-center">
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-secondary">
            <FileWarning className="h-5 w-5" />
          </span>
          <p className="mt-4 text-base font-semibold">No unreadable documents</p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
            Everything sent so far produced readable text. Photos that fail OCR will show up here.
          </p>
        </div>
      )}
    </div>
  );
}
