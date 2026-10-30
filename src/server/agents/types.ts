import { randomUUID } from "node:crypto";

import type {
  Destination,
  DocType,
  PermissionLevel,
  Role,
  SessionUser,
  TenantSettings,
} from "@/lib/types";

export const AGENT_IDS = [
  "chat_orchestrator",
  "document_classifier",
  "extraction",
  "master_matcher",
  "validation_explainer",
  "destination_mapper",
  "bank_categoriser",
  "learning_curator",
] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export type AgentMode = "deterministic" | "model";

/**
 * Every pipeline agent returns its result with this envelope. It is stored on
 * the record so reviewers and the learning loop can see why a decision was made.
 */
export interface AgentEnvelope {
  confidence: number;
  warnings: string[];
  reason: string;
  explanations?: RuleExplanation[] | undefined;
  match?:
    | {
        status: MatchResult["status"];
        confidence: number;
        reason: string;
        vendorName: string | null;
      }
    | undefined;
  agents?: string[] | undefined;
  escalated?: boolean | undefined;
}

export interface ToolCallSummary {
  name: string;
  kind: "read" | "write";
  status: "ok" | "error";
  summary: string;
  durationMs: number;
  replayed: boolean;
}

export interface AgentOutput<T> {
  result: T;
  envelope: AgentEnvelope;
  escalated?: boolean;
  runId?: string;
  toolCalls?: ToolCallSummary[];
}

export interface RunContextRefs {
  chatId?: string | null;
  documentId?: string | null;
  recordId?: string | null;
}

/**
 * The only way an agent reaches tenant data. The schema and tenant id come from
 * the signed server session, never from request input.
 */
export interface RunContext {
  tenantId: string;
  userId: string;
  schema: string;
  chatId: string | null;
  documentId: string | null;
  recordId: string | null;
  role: Role;
  autonomyMode: "draft" | "autonomous";
  /** The level active for this run. Agents can read it but never change it. */
  permissionLevel: PermissionLevel;
  killSwitch: boolean;
  settings: TenantSettings;
  pack: { key: string; version: string };
  traceId: string;
  /** The signed session, carried so tools can enforce role and amount limits. */
  session?: SessionUser | null;
}

export function contextFromSession(session: SessionUser, refs: RunContextRefs = {}): RunContext {
  return {
    tenantId: session.tenantId,
    userId: session.userId,
    schema: session.schema,
    chatId: refs.chatId ?? null,
    documentId: refs.documentId ?? null,
    recordId: refs.recordId ?? null,
    role: session.role,
    autonomyMode: session.autonomyMode,
    permissionLevel: session.permissionLevel,
    killSwitch: session.killSwitch,
    settings: session.settings,
    pack: { ...session.settings.pack },
    traceId: randomUUID(),
    session,
  };
}

export type SegmentDocType = DocType | "unknown";

export interface SegmentQuality {
  blurred?: boolean | undefined;
  rotated?: boolean | undefined;
  cropped?: boolean | undefined;
  note?: string | undefined;
}

export interface SegmentDescriptor {
  pageStart: number | null;
  pageEnd: number | null;
  docType: SegmentDocType;
  confidence: number;
  quality: SegmentQuality;
}

export interface ClassifiedSegment extends SegmentDescriptor {
  index: number;
  text: string;
}

export interface ClassifierResult {
  segments: SegmentDescriptor[];
}

export interface ExtractionLineItem {
  description: string;
  hsn?: string;
  quantity?: number;
  unit?: string;
  rate?: number;
  amount?: number;
  tax_rate?: number;
}

export interface ExtractedRecord {
  docType: DocType;
  fields: Record<string, unknown>;
  confidences: Record<string, number>;
  title: string;
  vendorStatus?: "active" | "cancelled" | "suspended" | "unknown" | undefined;
  locations?: Record<string, { page?: number | undefined; hint?: string | undefined }> | undefined;
}

export interface ExtractorResult {
  results: ExtractedRecord[];
}

export interface MatcherCandidate {
  name: string;
  gstin: string | null;
  ledger: string | null;
  confidence: number;
}

export interface MatchResult {
  status: "matched" | "ambiguous" | "new_party";
  vendor: MatcherCandidate | null;
  alternatives: MatcherCandidate[];
  confidence: number;
  reason: string;
}

export interface RuleExplanation {
  ruleId: string;
  outcome: "warn" | "fail";
  reason: string;
  nextStep: string;
}

export interface ExplainerResult {
  explanations: RuleExplanation[];
}

export interface ColumnMapping {
  column: string;
  field: string | null;
  fixedValue: string | null;
  confidence: number;
}

export interface MapperResult {
  columns: ColumnMapping[];
  unmapped: string[];
}

export interface CategoryResult {
  index: number;
  category: "vendor_payment" | "bank_charge" | "interest" | "tax" | "transfer" | "unknown";
  ledger: string | null;
  matchedVendor: string | null;
  confidence: number;
  reason: string;
}

export interface CategoriserResult {
  lines: CategoryResult[];
}

export interface OrchestratorIntent {
  intent: "approve" | "reject" | "hold" | "correct" | "status" | "help" | "understand" | "unknown";
  targets: number[];
  destination: Destination | null;
  field: string | null;
  value: string | null;
  reason: string | null;
  reply: string | null;
}

export interface CuratorRule {
  kind: "vendor_ledger" | "field_default" | "sheet_columns";
  scope: string;
  field: string;
  value: string;
  evidenceCount: number;
  example: string;
  description: string;
}

export interface CuratorResult {
  rules: CuratorRule[];
}

/**
 * Carries agent metadata from the orchestrating pipeline into record ingestion.
 * Kept optional so deterministic tests can call ingestExtraction directly.
 */
export interface IngestAgentMeta {
  context: RunContext;
  mode: AgentMode;
  escalated: boolean;
  results: {
    envelope: AgentEnvelope;
    extractionRunId: string | null;
    segmentIndex: number;
    explanation: RuleExplanation[] | null;
    /** The classifier saw blur, crop, rotation or a low-confidence type. */
    suspectedQuality?: boolean;
  }[];
}

export function emptyEnvelope(reason: string, confidence = 0): AgentEnvelope {
  return { confidence, warnings: [], reason };
}
