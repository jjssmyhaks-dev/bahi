export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type Role = "owner" | "reviewer" | "viewer";

export type Destination = "tally" | "excel" | "google_sheets";

export type DocType =
  | "supplier_invoice"
  | "credit_note"
  | "purchase_order"
  | "goods_receipt"
  | "e_way_bill"
  | "e_invoice"
  | "bank_statement";

export type RecordStatus =
  "pending_review" | "approved" | "posted" | "written" | "rejected" | "held" | "failed";

export type RuleOutcome = "pass" | "warn" | "fail" | "skipped";

export interface RuleResult {
  id: string;
  label: string;
  outcome: RuleOutcome;
  message: string;
}

export interface LineItem {
  description: string;
  hsn?: string;
  quantity?: number;
  unit?: string;
  rate?: number;
  amount?: number;
  tax_rate?: number;
}

export type FieldValue = string | number | boolean | null | undefined | LineItem[];

export interface FieldMap {
  vendor_name?: string | undefined;
  vendor_gstin?: string | undefined;
  vendor_state?: string | undefined;
  vendor_category?: string | undefined;
  vendor_status?: "active" | "cancelled" | "suspended" | "unknown" | undefined;
  invoice_number?: string | undefined;
  invoice_date?: string | undefined;
  place_of_supply?: string | undefined;
  line_items?: LineItem[] | undefined;
  taxable_value?: number | undefined;
  cgst?: number | undefined;
  sgst?: number | undefined;
  igst?: number | undefined;
  round_off?: number | undefined;
  total?: number | undefined;
  irn?: string | undefined;
  eway_bill_number?: string | undefined;
  vehicle_number?: string | undefined;
  po_number?: string | undefined;
  challan_number?: string | undefined;
  account_reference?: string | undefined;
  debit?: number | undefined;
  credit?: number | undefined;
  balance?: number | undefined;
  narration?: string | undefined;
  reference_number?: string | undefined;
  tds_section?: string | undefined;
  [key: string]: FieldValue;
}

export interface DestinationThreshold {
  minConfidence: number;
  allowWarnings: boolean;
}

export type AutonomyStage = 0 | 1 | 2 | 3 | 4;

export type PermissionLevel = "ask" | "auto" | "full";

export interface TenantSettings {
  thresholds: Record<Destination, DestinationThreshold>;
  /** Per-document overrides. A missing entry falls back to the destination threshold. */
  docThresholds: Partial<Record<DocType, DestinationThreshold>>;
  limits: {
    autoPostValueMinor: number;
    dailyPostCap: number;
    /** Per-document value caps. A missing entry falls back to autoPostValueMinor. */
    docValueMinor: Partial<Record<DocType, number>>;
  };
  gst: {
    toleranceMinor: number;
    eInvoiceThresholdMinor: number;
    eWayThresholdMinor: number;
    fyStart: string;
    knownHsnRates: Record<string, number>;
  };
  defaultDestination: Destination;
  pack: { key: string; version: string };
  autonomy: {
    stage: AutonomyStage;
    shadowMode: boolean;
    errorBudgetPct: number;
  };
  permissions: {
    level: PermissionLevel;
    /** Always needs a person above this amount. 0 turns the ceiling off. */
    ceilingMinor: number;
  };
  review: {
    autoAssign: boolean;
    dueDays: number;
  };
  retentionDays: number;
  notifications: {
    email: boolean;
    whatsapp: boolean;
    digest: "off" | "daily" | "weekly";
  };
  bridges: {
    preferBridge: boolean;
  };
}

export interface SessionUser {
  userId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: Role;
  name: string;
  email: string;
  schema: string;
  autonomyMode: "draft" | "autonomous";
  autonomyStage: AutonomyStage;
  shadowMode: boolean;
  killSwitch: boolean;
  retentionDays: number;
  errorBudgetPct: number;
  permissionLevel: PermissionLevel;
  settings: TenantSettings;
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: string;
  preview: string;
  pendingCount: number;
}

export interface RuleExplanation {
  ruleId: string;
  outcome: "warn" | "fail";
  reason: string;
  nextStep: string;
}

export interface RecordEnvelope {
  confidence?: number;
  warnings?: string[];
  reason?: string;
  explanations?: RuleExplanation[];
  match?: {
    status: "matched" | "ambiguous" | "new_party";
    confidence: number;
    reason: string;
    vendorName: string | null;
  };
  agents?: string[];
  escalated?: boolean;
  shadow?: boolean;
  wouldPost?: boolean;
  evidence?: ReviewEvidence;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  meta: {
    attachments?: { name: string; size: number; mime: string; documentId?: string }[];
    recordIds?: string[];
    kind?: "text" | "upload_result" | "intent_result" | "welcome";
    documents?: number;
    tools?: { name: string; status: "ok" | "failed"; summary: string }[];
  };
  createdAt: string;
}

export interface DocumentRow {
  id: string;
  chatId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string | null;
  status: "queued" | "processing" | "extracted" | "needs_attention" | "failed";
  docType: DocType | null;
  pageCount: number | null;
  extractedText: string | null;
  error: string | null;
  sourceChannel: "chat" | "email" | "whatsapp" | "api" | "sample";
  retentionUntil: string | null;
  renderMode: "text" | "vision" | "spreadsheet" | "typed" | null;
  /** Permission level active when this document run started. */
  permissionLevel: PermissionLevel | null;
  createdAt: string;
}

export interface FieldLocation {
  page?: number;
  hint?: string;
}

export interface ReviewEvidence {
  gstinStatus?: "active" | "cancelled" | "suspended" | "unknown";
  gstinVerifiedAt?: string;
  poMatched?: boolean;
  poNumber?: string;
  grMatched?: boolean;
  gstr2bMatch?: "matched" | "mismatch" | "missing_in_books" | "not_in_2b" | "unmatched";
  gstr2bPeriod?: string;
  [key: string]: string | number | boolean | null | undefined;
}

export interface ReviewRequestRow {
  id: string;
  recordId: string;
  kind: "document" | "clarification";
  message: string;
  status: "open" | "answered" | "cancelled";
  requestedBy: string | null;
  answeredBy: string | null;
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
}

export interface RecordRow {
  id: string;
  chatId: string | null;
  documentId: string | null;
  docType: DocType;
  title: string;
  fields: FieldMap;
  confidences: Record<string, number>;
  validation: RuleResult[];
  overallConfidence: number;
  status: RecordStatus;
  destination: Destination;
  destinationRef: string | null;
  destinationNote: string | null;
  reason: string | null;
  priority: number;
  amountMinor: number;
  idempotencyKey: string;
  groupKey: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  dueAt: string | null;
  reviewReason: string | null;
  locations: Record<string, FieldLocation>;
  evidence: ReviewEvidence;
  shadow: boolean;
  sourceChannel: "chat" | "email" | "whatsapp" | "api" | "sample";
  /** Permission level active when the record was routed. */
  permissionLevel: PermissionLevel | null;
  /** Permission level active when the record was approved or written. */
  approvedPermissionLevel: PermissionLevel | null;
  postedAt: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  envelope: RecordEnvelope;
  agentMode: "deterministic" | "model" | null;
  document?: DocumentRow | null;
}

export interface Workspace {
  user: { id: string; name: string; email: string; role: Role };
  tenant: {
    id: string;
    name: string;
    slug: string;
    autonomyMode: "draft" | "autonomous";
    killSwitch: boolean;
    settings: TenantSettings;
  };
  chats: ChatSummary[];
  counts: { pending: number; exceptions: number; today: number };
  sheetConnection: {
    id: string;
    spreadsheetName: string;
    sheetName: string;
    status: string;
  } | null;
}

export interface ActivityRow {
  id: string;
  action: string;
  detail: JsonObject;
  recordId: string | null;
  actor: string | null;
  createdAt: string;
}

export interface PostRow {
  id: string;
  destination: Destination;
  status: "pending" | "queued" | "posted" | "failed";
  externalRef: string | null;
  payload: JsonObject | null;
  result: JsonObject | null;
  createdAt: string;
  completedAt: string | null;
}

export interface BridgeAgentRow {
  id: string;
  label: string;
  companyName: string;
  status: "active" | "revoked";
  version: string | null;
  lastSeenAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface BridgeCommandRow {
  id: string;
  type: string;
  idempotencyKey: string;
  status: "queued" | "delivered" | "acked" | "failed" | "expired";
  attempts: number;
  payload: JsonObject;
  result: JsonObject | null;
  error: string | null;
  recordId: string | null;
  createdAt: string;
  deliveredAt: string | null;
  completedAt: string | null;
}

export interface MemberRow {
  userId: string;
  name: string;
  email: string;
  role: Role;
  createdAt: string;
}

export interface InviteRow {
  id: string;
  email: string;
  role: Role;
  status: "pending" | "accepted" | "expired";
  expiresAt: string;
  createdAt: string;
}

export interface Gstr2bLine {
  id: string;
  period: string;
  supplierGstin: string;
  supplierName: string | null;
  invoiceNumber: string;
  invoiceDate: string | null;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  itcStatus: string | null;
  matchStatus: "matched" | "unmatched" | "mismatch" | "missing_in_books";
}

export interface PackRow {
  key: string;
  version: string;
  name: string;
  industry: string;
  status: "draft" | "published" | "retired";
  config: JsonObject;
  isActive?: boolean;
}

export interface IntegrityMetrics {
  periodDays: number;
  posted: number;
  autoPosted: number;
  shadowed: number;
  reviewed: number;
  corrections: number;
  reversals: number;
  unreversedErrors: number;
  wrongLedgerErrors: number;
  wrongTaxErrors: number;
  autoErrorRatePct: number;
  reviewSharePct: number;
  medianReviewMinutes: number | null;
  fieldAccuracyPct: number | null;
  evaluations: number;
  stage: AutonomyStage;
  errorBudgetPct: number;
  gate: { passed: boolean; reasons: string[] };
}

export interface SheetRow {
  rowNumber: number;
  values: Record<string, string | number>;
  createdAt: string;
  recordId: string;
}
