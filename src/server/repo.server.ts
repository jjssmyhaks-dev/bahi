import type {
  ActivityRow,
  ChatMessage,
  ChatSummary,
  DocumentRow,
  Destination,
  DocType,
  JsonObject,
  PostRow,
  RecordRow,
  RecordStatus,
  RuleResult,
  SessionUser,
  SheetRow,
  Workspace,
} from "@/lib/types";
import { DEFAULT_SETTINGS, mergeSettings } from "@/lib/settings";
import { isPermissionLevel } from "@/lib/permissions";
import { sql, sqlOne, table } from "./db.server";

const iso = (value: unknown): string | null => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
};

export function mapDocument(row: Record<string, unknown> | null | undefined): DocumentRow | null {
  if (!row) return null;
  return {
    id: String(row.id),
    chatId: row.chat_id ? String(row.chat_id) : null,
    filename: String(row.filename),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes ?? 0),
    storagePath: row.storage_path ? String(row.storage_path) : null,
    status: row.status as DocumentRow["status"],
    docType: row.doc_type ? (String(row.doc_type) as DocType) : null,
    pageCount:
      row.page_count === null || row.page_count === undefined ? null : Number(row.page_count),
    extractedText: row.extracted_text === undefined ? null : (row.extracted_text as string | null),
    error: row.error === undefined ? null : (row.error as string | null),
    sourceChannel: (row.source_channel as DocumentRow["sourceChannel"] | undefined) ?? "chat",
    retentionUntil: iso(row.retention_until),
    renderMode: (row.render_mode as DocumentRow["renderMode"] | undefined) ?? null,
    permissionLevel: isPermissionLevel(row.permission_level) ? row.permission_level : null,
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
  };
}

export function mapRecord(row: Record<string, unknown>, document?: DocumentRow | null): RecordRow {
  return {
    id: String(row.id),
    chatId: row.chat_id ? String(row.chat_id) : null,
    documentId: row.document_id ? String(row.document_id) : null,
    docType: row.doc_type as DocType,
    title: String(row.title),
    fields: (row.fields as RecordRow["fields"]) ?? {},
    confidences: (row.confidences as Record<string, number>) ?? {},
    validation: (row.validation as RuleResult[]) ?? [],
    overallConfidence: Number(row.overall_confidence ?? 0),
    status: row.status as RecordStatus,
    destination: row.destination as Destination,
    destinationRef: row.destination_ref ? String(row.destination_ref) : null,
    destinationNote: row.destination_note ? String(row.destination_note) : null,
    reason: row.reason ? String(row.reason) : null,
    priority: Number(row.priority ?? 100),
    amountMinor: Number(row.amount_minor ?? 0),
    idempotencyKey: String(row.idempotency_key),
    groupKey: row.group_key ? String(row.group_key) : null,
    assignedTo: row.assigned_to ? String(row.assigned_to) : null,
    assignedToName: row.assigned_name ? String(row.assigned_name) : null,
    dueAt: iso(row.due_at),
    reviewReason: row.review_reason ? String(row.review_reason) : null,
    locations: (row.locations as RecordRow["locations"]) ?? {},
    evidence: (row.evidence as RecordRow["evidence"]) ?? {},
    shadow: Boolean(row.shadow),
    sourceChannel: (row.source_channel as RecordRow["sourceChannel"] | undefined) ?? "chat",
    postedAt: iso(row.posted_at),
    reviewedAt: iso(row.reviewed_at),
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
    envelope: (row.envelope as Record<string, unknown> | undefined)
      ? (row.envelope as RecordRow["envelope"])
      : {},
    agentMode:
      row.agent_mode === "model" || row.agent_mode === "deterministic" ? row.agent_mode : null,
    permissionLevel: isPermissionLevel(row.permission_level) ? row.permission_level : null,
    approvedPermissionLevel: isPermissionLevel(row.approved_permission_level)
      ? row.approved_permission_level
      : null,
    document: document ?? null,
  };
}

const RECORD_SELECT = `r.*, u.name as assigned_name, d.id as d_id, d.filename as d_filename, d.mime_type as d_mime,
  d.size_bytes as d_size, d.storage_path as d_path, d.status as d_status, d.doc_type as d_doc_type,
  d.page_count as d_pages, d.extracted_text as d_text, d.error as d_error, d.created_at as d_created,
  d.source_channel as d_source_channel, d.retention_until as d_retention_until,
  d.render_mode as d_render_mode, d.permission_level as d_permission_level`;

const DOCUMENT_FIELDS = `d_id, d_filename, d_mime, d_size, d_path, d_status, d_doc_type, d_pages, d_text, d_error, d_created`;

function docFromJoined(row: Record<string, unknown>): DocumentRow | null {
  if (!row.d_id) return null;
  return mapDocument({
    id: row.d_id,
    chat_id: row.chat_id,
    filename: row.d_filename,
    mime_type: row.d_mime,
    size_bytes: row.d_size,
    storage_path: row.d_path,
    status: row.d_status,
    doc_type: row.d_doc_type,
    page_count: row.d_pages,
    extracted_text: row.d_text,
    error: row.d_error,
    source_channel: row.d_source_channel,
    retention_until: row.d_retention_until,
    render_mode: row.d_render_mode,
    permission_level: row.d_permission_level,
    created_at: row.d_created,
  });
}

export async function getRecord(schema: string, recordId: string): Promise<RecordRow | null> {
  const row = await sqlOne<Record<string, unknown>>(
    `select ${RECORD_SELECT} from ${table(schema, "records")} r
       left join bahi.users u on u.id = r.assigned_to
       left join ${table(schema, "documents")} d on d.id = r.document_id
      where r.id = $1`,
    [recordId],
  );
  return row ? mapRecord(row, docFromJoined(row)) : null;
}

export async function listRecordsForChat(schema: string, chatId: string): Promise<RecordRow[]> {
  const rows = await sql<Record<string, unknown>>(
    `select ${RECORD_SELECT} from ${table(schema, "records")} r
       left join bahi.users u on u.id = r.assigned_to
       left join ${table(schema, "documents")} d on d.id = r.document_id
      where r.chat_id = $1 order by r.created_at asc`,
    [chatId],
  );
  return rows.map((row) => mapRecord(row, docFromJoined(row)));
}

export interface ChatDocumentRef {
  id: string;
  filename: string;
  status: string;
}

export async function listDocumentsForChat(
  schema: string,
  chatId: string,
): Promise<ChatDocumentRef[]> {
  const rows = await sql<Record<string, unknown>>(
    `select id, filename, status from ${table(schema, "documents")}
      where chat_id = $1 order by created_at asc`,
    [chatId],
  );
  return rows.map((row) => ({
    id: String(row["id"]),
    filename: String(row["filename"]),
    status: String(row["status"]),
  }));
}

export async function listMessages(schema: string, chatId: string): Promise<ChatMessage[]> {
  const rows = await sql<Record<string, unknown>>(
    `select * from ${table(schema, "messages")} where chat_id = $1 order by created_at asc`,
    [chatId],
  );
  return rows.map((row) => ({
    id: String(row.id),
    role: row.role as ChatMessage["role"],
    content: String(row.content),
    meta: (row.meta as ChatMessage["meta"]) ?? {},
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
  }));
}

export async function listChats(schema: string, userId: string): Promise<ChatSummary[]> {
  const rows = await sql<Record<string, unknown>>(
    `select c.id, c.title, c.updated_at,
            (select content from ${table(schema, "messages")} m where m.chat_id = c.id order by m.created_at desc limit 1) as preview,
            (select count(*)::int from ${table(schema, "records")} r where r.chat_id = c.id and r.status in ('pending_review','held')) as pending
       from ${table(schema, "chats")} c
      where c.user_id = $1
      order by c.updated_at desc limit 40`,
    [userId],
  );
  return rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
    preview: String(row.preview ?? "").slice(0, 120),
    pendingCount: Number(row.pending ?? 0),
  }));
}

export async function getChat(
  schema: string,
  chatId: string,
  userId: string,
): Promise<{ chat: ChatSummary; messages: ChatMessage[]; records: RecordRow[] } | null> {
  const chat = await sqlOne<Record<string, unknown>>(
    `select id, title, updated_at from ${table(schema, "chats")} where id = $1 and user_id = $2`,
    [chatId, userId],
  );
  if (!chat) return null;
  const [messages, records] = await Promise.all([
    listMessages(schema, chatId),
    listRecordsForChat(schema, chatId),
  ]);
  return {
    chat: {
      id: String(chat.id),
      title: String(chat.title),
      updatedAt: iso(chat.updated_at) ?? new Date().toISOString(),
      preview: "",
      pendingCount: records.filter((r) => r.status === "pending_review" || r.status === "held")
        .length,
    },
    messages,
    records,
  };
}

export async function createChat(
  schema: string,
  userId: string,
  title = "New conversation",
): Promise<string> {
  const row = await sqlOne<{ id: string }>(
    `insert into ${table(schema, "chats")} (user_id, title) values ($1, $2) returning id`,
    [userId, title],
  );
  if (!row) throw new Error("Could not create chat");
  return row.id;
}

export interface QueueFilters {
  status?: "open" | "pending_review" | "held" | "posted" | "written" | "rejected" | "failed";
  docType?: DocType;
  destination?: Destination;
  reason?: "fail" | "warn" | "confidence" | "unassigned" | "overdue";
  assignedTo?: string;
  ageDays?: number;
  groupKey?: string;
  search?: string;
}

export async function listQueue(schema: string, filters: QueueFilters = {}): Promise<RecordRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (!filters.status || filters.status === "open") {
    clauses.push(`r.status in ('pending_review','held')`);
  } else {
    params.push(filters.status);
    clauses.push(`r.status = $${params.length}`);
  }
  if (filters.docType) {
    params.push(filters.docType);
    clauses.push(`r.doc_type = $${params.length}`);
  }
  if (filters.destination) {
    params.push(filters.destination);
    clauses.push(`r.destination = $${params.length}`);
  }
  if (filters.reason === "fail") clauses.push(`r.validation @> '[{"outcome":"fail"}]'::jsonb`);
  if (filters.reason === "warn") clauses.push(`r.validation @> '[{"outcome":"warn"}]'::jsonb`);
  if (filters.reason === "confidence") clauses.push(`r.overall_confidence < 0.95`);
  if (filters.reason === "unassigned") clauses.push(`r.assigned_to is null`);
  if (filters.reason === "overdue") clauses.push(`r.due_at is not null and r.due_at < now()`);
  if (filters.assignedTo) {
    params.push(filters.assignedTo);
    clauses.push(`r.assigned_to = $${params.length}::uuid`);
  }
  if (filters.ageDays && filters.ageDays > 0) {
    params.push(filters.ageDays);
    clauses.push(`r.created_at <= now() - ($${params.length}::int * interval '1 day')`);
  }
  if (filters.groupKey) {
    params.push(filters.groupKey);
    clauses.push(`r.group_key = $${params.length}`);
  }
  if (filters.search?.trim()) {
    params.push(`%${filters.search.trim().toLowerCase()}%`);
    clauses.push(
      `(lower(r.title) like $${params.length}
        or lower(coalesce(r.fields->>'vendor_name','')) like $${params.length}
        or lower(coalesce(r.fields->>'invoice_number','')) like $${params.length})`,
    );
  }

  const rows = await sql<Record<string, unknown>>(
    `select ${RECORD_SELECT} from ${table(schema, "records")} r
       left join bahi.users u on u.id = r.assigned_to
       left join ${table(schema, "documents")} d on d.id = r.document_id
      where ${clauses.join(" and ")}
      order by r.priority asc, r.amount_minor desc, r.created_at asc
      limit 200`,
    params,
  );
  return rows.map((row) => mapRecord(row, docFromJoined(row)));
}

export interface QueueMetrics {
  open: number;
  unassigned: number;
  overdue: number;
  dueToday: number;
  failedRules: number;
  lowConfidence: number;
  medianAgeHours: number | null;
  byDocType: { docType: string; count: number }[];
}

export async function getQueueMetrics(schema: string): Promise<QueueMetrics> {
  const row = await sqlOne<Record<string, unknown>>(
    `select
       count(*) filter (where status in ('pending_review','held'))::int as open,
       count(*) filter (where status in ('pending_review','held') and assigned_to is null)::int as unassigned,
       count(*) filter (where status in ('pending_review','held') and due_at is not null and due_at < now())::int as overdue,
       count(*) filter (where status in ('pending_review','held') and due_at >= current_date and due_at < current_date + interval '1 day')::int as due_today,
       count(*) filter (where status in ('pending_review','held') and validation @> '[{"outcome":"fail"}]'::jsonb)::int as failed_rules,
       count(*) filter (where status in ('pending_review','held') and overall_confidence < 0.95)::int as low_confidence,
       percentile_cont(0.5) within group (
         order by extract(epoch from (now() - created_at)) / 3600
       ) filter (where status in ('pending_review','held')) as median_age_hours
     from ${table(schema, "records")}`,
  );
  const byType = await sql<{ doc_type: string; n: number }>(
    `select doc_type, count(*)::int as n from ${table(schema, "records")}
      where status in ('pending_review','held') group by doc_type order by n desc`,
  );
  return {
    open: Number(row?.open ?? 0),
    unassigned: Number(row?.unassigned ?? 0),
    overdue: Number(row?.overdue ?? 0),
    dueToday: Number(row?.due_today ?? 0),
    failedRules: Number(row?.failed_rules ?? 0),
    lowConfidence: Number(row?.low_confidence ?? 0),
    medianAgeHours:
      row?.median_age_hours === null || row?.median_age_hours === undefined
        ? null
        : Math.round(Number(row.median_age_hours) * 10) / 10,
    byDocType: byType.map((entry) => ({ docType: entry.doc_type, count: Number(entry.n) })),
  };
}

export async function getQueueCounts(
  schema: string,
): Promise<{ pending: number; exceptions: number; today: number }> {
  const [pending, exceptions, today] = await Promise.all([
    sqlOne<{ n: number }>(
      `select count(*)::int as n from ${table(schema, "records")} where status in ('pending_review','held')`,
    ),
    sqlOne<{ n: number }>(
      `select count(*)::int as n from ${table(schema, "documents")} where status in ('needs_attention','failed')`,
    ),
    sqlOne<{ n: number }>(
      `select count(*)::int as n from ${table(schema, "records")} where posted_at >= current_date`,
    ),
  ]);
  return {
    pending: Number(pending?.n ?? 0),
    exceptions: Number(exceptions?.n ?? 0),
    today: Number(today?.n ?? 0),
  };
}

export async function getWorkspace(session: SessionUser): Promise<Workspace> {
  const schema = session.schema;
  const [chats, counts, sheet] = await Promise.all([
    listChats(schema, session.userId),
    getQueueCounts(schema),
    sqlOne<{ id: string; spreadsheet_name: string; sheet_name: string; status: string }>(
      `select id, spreadsheet_name, sheet_name, status from ${table(schema, "sheet_connections")}
        where provider = 'google_sheets' order by created_at asc limit 1`,
    ),
  ]);

  return {
    user: { id: session.userId, name: session.name, email: session.email, role: session.role },
    tenant: {
      id: session.tenantId,
      name: session.tenantName,
      slug: session.tenantSlug,
      autonomyMode: session.autonomyMode,
      killSwitch: session.killSwitch,
      settings: session.settings,
    },
    chats,
    counts,
    sheetConnection: sheet
      ? {
          id: sheet.id,
          spreadsheetName: sheet.spreadsheet_name,
          sheetName: sheet.sheet_name,
          status: sheet.status,
        }
      : null,
  };
}

export async function listActivity(schema: string, limit = 100): Promise<ActivityRow[]> {
  const rows = await sql<Record<string, unknown>>(
    `select a.id, a.action, a.detail, a.record_id, a.created_at, u.name as actor
       from ${table(schema, "activity")} a
       left join bahi.users u on u.id = a.user_id
      order by a.created_at desc limit $1`,
    [limit],
  );
  return rows.map((row) => ({
    id: String(row.id),
    action: String(row.action),
    detail: (row.detail as JsonObject) ?? {},
    recordId: row.record_id ? String(row.record_id) : null,
    actor: row.actor ? String(row.actor) : null,
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
  }));
}

export async function listExceptions(schema: string): Promise<DocumentRow[]> {
  const rows = await sql<Record<string, unknown>>(
    `select * from ${table(schema, "documents")} where status in ('needs_attention','failed')
      order by created_at desc limit 100`,
  );
  return rows.map((row) => mapDocument(row)!).filter(Boolean);
}

export async function listPosts(schema: string, recordId: string): Promise<PostRow[]> {
  const rows = await sql<Record<string, unknown>>(
    `select * from ${table(schema, "posts")} where record_id = $1 order by created_at desc`,
    [recordId],
  );
  return rows.map((row) => ({
    id: String(row.id),
    destination: row.destination as Destination,
    status: row.status as PostRow["status"],
    externalRef: row.external_ref ? String(row.external_ref) : null,
    payload: (row.payload as JsonObject) ?? null,
    result: (row.result as JsonObject) ?? null,
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
    completedAt: iso(row.completed_at),
  }));
}

export async function listSheetRows(schema: string): Promise<SheetRow[]> {
  const rows = await sql<Record<string, unknown>>(
    `select row_number, values, created_at, record_id from ${table(schema, "sheet_rows")}
      order by row_number asc limit 500`,
  );
  return rows.map((row) => ({
    rowNumber: Number(row.row_number),
    values: (row.values as Record<string, string | number>) ?? {},
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
    recordId: String(row.record_id),
  }));
}

export async function existingRecordKeys(schema: string) {
  const rows = await sql<{
    id: string;
    vendor_gstin: string | null;
    invoice_number: string | null;
    amount_minor: string;
    title: string;
  }>(
    `select id, fields ->> 'vendor_gstin' as vendor_gstin, fields ->> 'invoice_number' as invoice_number,
            amount_minor, title
       from ${table(schema, "records")} order by created_at desc limit 500`,
  );
  return rows.map((row) => ({
    id: row.id,
    vendorGstin: row.vendor_gstin,
    invoiceNumber: row.invoice_number,
    amountMinor: Number(row.amount_minor),
    title: row.title,
  }));
}

export async function insertAssistantMessage(
  schema: string,
  chatId: string,
  content: string,
  meta: Record<string, unknown>,
): Promise<string> {
  const row = await sqlOne<{ id: string }>(
    `insert into ${table(schema, "messages")} (chat_id, role, content, meta) values ($1, 'assistant', $2, $3::jsonb) returning id`,
    [chatId, content, JSON.stringify(meta)],
  );
  if (!row) throw new Error("Could not write message");
  return row.id;
}

export async function insertUserMessage(
  schema: string,
  chatId: string,
  content: string,
  meta: Record<string, unknown> = {},
): Promise<string> {
  const row = await sqlOne<{ id: string }>(
    `insert into ${table(schema, "messages")} (chat_id, role, content, meta) values ($1, 'user', $2, $3::jsonb) returning id`,
    [chatId, content, JSON.stringify(meta)],
  );
  if (!row) throw new Error("Could not write message");
  return row.id;
}

export async function touchChat(schema: string, chatId: string, title?: string) {
  if (title) {
    await sql(`update ${table(schema, "chats")} set title = $2, updated_at = now() where id = $1`, [
      chatId,
      title,
    ]);
  } else {
    await sql(`update ${table(schema, "chats")} set updated_at = now() where id = $1`, [chatId]);
  }
}

export { DEFAULT_SETTINGS, mergeSettings };
