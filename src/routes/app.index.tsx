import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Loader2, MessageSquarePlus, Paperclip, Send, Sparkles, X } from "lucide-react";
import { toast } from "sonner";

import { LogoMark } from "@/components/brand";
import { PermissionPicker } from "@/components/app/permission-picker";
import { RecordCard } from "@/components/app/record-card";
import { RecordDetail } from "@/components/app/record-detail";
import { formatDateTime, timeAgo } from "@/lib/format";
import { PERMISSION_LABELS } from "@/lib/permissions";
import type { ChatMessage, Destination } from "@/lib/types";
import {
  chatFn,
  newChatFn,
  samplesFn,
  sendMessageFn,
  startSampleFn,
  uploadFn,
  workspaceFn,
} from "@/lib/api";

type ChatPayload = Awaited<ReturnType<typeof chatFn>>;
type SampleInfo = Awaited<ReturnType<typeof samplesFn>>[number];

type ChatSearch = { chat?: string | undefined };

export const Route = createFileRoute("/app/")({
  validateSearch: (search: Record<string, unknown>): ChatSearch => ({
    chat: typeof search.chat === "string" ? search.chat : undefined,
  }),
  component: ChatPage,
});

function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={index} className="font-semibold text-foreground">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}

function RichText({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="space-y-1.5 text-sm leading-relaxed">
      {lines.map((line, index) => {
        if (!line.trim()) return <div key={index} className="h-1" />;
        const bullet = /^[•-]\s/.test(line);
        return (
          <p key={index} className={bullet ? "-indent-3 pl-3" : undefined}>
            {inline(line)}
          </p>
        );
      })}
    </div>
  );
}

function bytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function MessageBubble({
  message,
  payload,
  onOpenRecord,
}: {
  message: ChatMessage;
  payload: ChatPayload;
  onOpenRecord: (id: string) => void;
}) {
  const records = (message.meta.recordIds ?? [])
    .map((id) => payload.records.find((record) => record.id === id))
    .filter((record): record is ChatPayload["records"][number] => Boolean(record));

  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-2">
        <div className="max-w-[88%] rounded-2xl rounded-br-md bg-foreground px-4 py-3 text-sm leading-relaxed text-background">
          <p className="whitespace-pre-wrap">{message.content}</p>
          {message.meta.attachments?.length ? (
            <div className="mt-2 space-y-1 border-t border-white/15 pt-2">
              {message.meta.attachments.map((file) => (
                <p
                  key={file.name}
                  className="flex items-center gap-1.5 text-[11px] text-background/70"
                >
                  <FileText className="h-3 w-3" />
                  {file.name} · {bytes(file.size)}
                </p>
              ))}
            </div>
          ) : null}
        </div>
        <span className="pr-1 text-[10px] text-muted-foreground">
          {formatDateTime(message.createdAt)}
        </span>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <span className="mt-1 hidden h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-card sm:flex">
        <LogoMark size={16} />
      </span>
      <div className="min-w-0 flex-1 space-y-2.5">
        <div className="rounded-2xl rounded-tl-md border border-border bg-card px-4 py-3 text-foreground">
          <RichText text={message.content} />
        </div>
        {message.meta.tools?.length ? (
          <div className="flex flex-wrap items-center gap-1.5 pl-1">
            {message.meta.tools.map((tool, index) => (
              <span
                key={`${tool.name}-${index}`}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[10px] text-muted-foreground"
              >
                <Sparkles className="h-3 w-3" />
                {tool.name} · {tool.summary}
              </span>
            ))}
          </div>
        ) : null}
        {records.length ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {records.map((record) => (
              <RecordCard key={record.id} record={record} onOpen={onOpenRecord} />
            ))}
          </div>
        ) : null}
        <span className="block pl-1 text-[10px] text-muted-foreground">
          {timeAgo(message.createdAt)}
        </span>
      </div>
    </div>
  );
}

function ChatPage() {
  const { chat: selectedChatId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();

  const [text, setText] = useState("");
  const [destination, setDestination] = useState<Destination | "auto">("auto");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [showSamples, setShowSamples] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const workspace = useQuery({
    queryKey: ["workspace"],
    queryFn: () => workspaceFn(),
    staleTime: 20_000,
  });
  const samples = useQuery({
    queryKey: ["samples"],
    queryFn: () => samplesFn(),
    staleTime: 300_000,
  });

  const chatId = selectedChatId ?? workspace.data?.chats[0]?.id ?? null;

  const chat = useQuery({
    queryKey: ["chat", chatId],
    queryFn: () => chatFn({ data: { chatId: chatId ?? "" } }),
    enabled: Boolean(chatId),
  });

  const payload = chat.data;
  const messages = payload?.messages ?? [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, payload?.chatId]);

  useEffect(() => {
    if (!selectedChatId && workspace.data?.chats[0]?.id) {
      navigate({ search: { chat: workspace.data.chats[0].id }, replace: true });
    }
  }, [selectedChatId, workspace.data?.chats, navigate]);

  function applyPayload(next: ChatPayload) {
    queryClient.setQueryData(["chat", next.chatId], next);
    void queryClient.invalidateQueries({ queryKey: ["workspace"] });
    if (next.chatId !== chatId) navigate({ search: { chat: next.chatId }, replace: true });
  }

  async function send() {
    const value = text.trim();
    if (!value || sending || uploading) return;
    setSending(true);
    setText("");
    try {
      const next = await sendMessageFn({
        data: { ...(chatId ? { chatId } : {}), text: value },
      });
      applyPayload(next);
    } catch (error) {
      setText(value);
      toast.error(error instanceof Error ? error.message : "The message did not go through.");
    } finally {
      setSending(false);
    }
  }

  async function upload(files: FileList | null) {
    if (!files || !files.length) return;
    const list = Array.from(files).slice(0, 8);
    setUploading(true);
    try {
      const encoded = await Promise.all(
        list.map(
          (file) =>
            new Promise<{ name: string; mimeType: string; base64: string }>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                const result = String(reader.result ?? "");
                resolve({
                  name: file.name,
                  mimeType: file.type || "application/octet-stream",
                  base64: result.includes(",") ? result.slice(result.indexOf(",") + 1) : result,
                });
              };
              reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
              reader.readAsDataURL(file);
            }),
        ),
      );
      const next = await uploadFn({
        data: {
          ...(chatId ? { chatId } : {}),
          files: encoded,
          ...(destination !== "auto" ? { destination } : {}),
        },
      });
      applyPayload(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The upload did not go through.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function runSample(sample: SampleInfo) {
    setShowSamples(false);
    setSending(true);
    try {
      const next = await startSampleFn({
        data: { ...(chatId ? { chatId } : {}), sampleId: sample.id },
      });
      applyPayload(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not run the sample.");
    } finally {
      setSending(false);
    }
  }

  async function startBlankChat() {
    const { chatId: id } = await newChatFn();
    void queryClient.invalidateQueries({ queryKey: ["workspace"] });
    navigate({ search: { chat: id } });
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-3xl flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div className="min-w-0">
          <p className="eyebrow">Conversation</p>
          <h1 className="mt-1 truncate text-xl font-semibold tracking-tight">
            {payload?.title ?? "New conversation"}
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {workspace.data?.counts.pending
              ? `${workspace.data.counts.pending} record${workspace.data.counts.pending === 1 ? "" : "s"} waiting in the review queue`
              : "Review queue is clear"}
            {workspace.data
              ? ` · ${PERMISSION_LABELS[workspace.data.tenant.settings.permissions.level]}`
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSamples((value) => !value)}
            className="btn-outline h-9 px-4 text-xs"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Samples
          </button>
          <button type="button" onClick={startBlankChat} className="btn-outline h-9 px-4 text-xs">
            <MessageSquarePlus className="h-3.5 w-3.5" />
            New
          </button>
        </div>
      </div>

      {showSamples ? (
        <div className="mt-4 rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">Run a sample document</p>
            <button
              type="button"
              onClick={() => setShowSamples(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {(samples.data ?? []).map((sample) => (
              <button
                key={sample.id}
                type="button"
                onClick={() => runSample(sample)}
                disabled={sending || uploading}
                className="rounded-xl border border-border bg-background p-3 text-left transition-colors hover:bg-muted disabled:opacity-50"
              >
                <p className="text-xs font-semibold">{sample.label}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {sample.description}
                </p>
                <p className="mt-2 truncate font-mono text-[10px] text-muted-foreground">
                  {sample.filename}
                </p>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex-1 space-y-6 py-6">
        {chat.isLoading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : chat.isError ? (
          <div className="rounded-2xl border border-border bg-card p-8 text-center">
            <p className="text-sm font-semibold">That conversation could not be opened.</p>
            <p className="mt-2 text-xs text-muted-foreground">
              It may have been removed, or the session expired.
            </p>
            <button
              type="button"
              onClick={startBlankChat}
              className="btn-primary mt-5 h-9 px-4 text-xs"
            >
              Start a new conversation
            </button>
          </div>
        ) : messages.length ? (
          messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              payload={payload!}
              onOpenRecord={setDetailId}
            />
          ))
        ) : (
          <div className="rounded-2xl border border-border bg-card p-8 text-center">
            <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-secondary">
              <Sparkles className="h-5 w-5" />
            </span>
            <p className="mt-4 text-base font-semibold">
              Send a bill, a statement, or one line of text
            </p>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              Try “Enter the Deccan Steel invoice in Tally”, attach a PDF, or run one of the samples
              to see the full read → check → post flow.
            </p>
            <button
              type="button"
              onClick={() => setShowSamples(true)}
              className="btn-outline mt-5 h-9 px-4 text-xs"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Browse samples
            </button>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="sticky bottom-0 z-10 -mx-1 border-t border-border bg-background/95 px-1 pb-2 pt-3 backdrop-blur">
        {uploading ? (
          <p className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Reading the document and running checks…
          </p>
        ) : null}
        <div className="rounded-2xl border border-border bg-card p-2 shadow-[0_18px_40px_-24px_rgb(0_0_0/0.2)]">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder="Enter this invoice in Tally, or ask what is waiting…"
            className="max-h-40 min-h-[3.25rem] w-full resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-1">
            <div className="flex items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                accept=".pdf,.csv,.xlsx,.xls,.txt,.png,.jpg,.jpeg,.webp,.doc,.docx"
                onChange={(event) => void upload(event.target.files)}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading || sending}
                className="inline-flex items-center gap-2 rounded-full px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                <Paperclip className="h-4 w-4" />
                Attach
              </button>
              <select
                value={destination}
                onChange={(event) => setDestination(event.target.value as Destination | "auto")}
                className="h-8 rounded-full border border-border bg-background px-3 text-xs outline-none"
              >
                <option value="auto">Destination: auto</option>
                <option value="tally">TallyPrime</option>
                <option value="excel">Excel</option>
                <option value="google_sheets">Google Sheets</option>
              </select>
              <PermissionPicker
                level={workspace.data?.tenant.settings.permissions.level ?? "auto"}
                canChange={workspace.data?.user.role === "owner"}
              />
            </div>
            <button
              type="button"
              onClick={send}
              disabled={!text.trim() || sending || uploading}
              className="btn-primary h-9 px-4 text-xs"
            >
              {sending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              {sending ? "Working…" : "Send"}
            </button>
          </div>
        </div>
        <p className="mt-2 px-1 text-[10px] text-muted-foreground">
          Enter to send · Shift + Enter for a new line · PDF, Excel, CSV or a photo of a bill
        </p>
      </div>

      <RecordDetail
        recordId={detailId}
        open={Boolean(detailId)}
        onOpenChange={(open) => !open && setDetailId(null)}
      />
    </div>
  );
}
