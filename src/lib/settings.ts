import { isPermissionLevel } from "./permissions";
import type { Destination, DocType, TenantSettings } from "./types";

export const DEFAULT_SETTINGS: TenantSettings = {
  thresholds: {
    tally: { minConfidence: 0.95, allowWarnings: false },
    excel: { minConfidence: 0.85, allowWarnings: true },
    google_sheets: { minConfidence: 0.85, allowWarnings: true },
  },
  docThresholds: {},
  limits: {
    autoPostValueMinor: 5_000_000,
    dailyPostCap: 100,
    docValueMinor: {},
  },
  gst: {
    toleranceMinor: 200,
    eInvoiceThresholdMinor: 500_000_000,
    eWayThresholdMinor: 5_000_000,
    fyStart: "2026-04-01",
    knownHsnRates: { "7306": 18, "3917": 18, "8481": 18, "7318": 18, "3926": 18 },
  },
  defaultDestination: "tally",
  pack: { key: "manufacturing", version: "1.0.0" },
  autonomy: { stage: 1, shadowMode: true, errorBudgetPct: 0.5 },
  permissions: { level: "auto", ceilingMinor: 0 },
  review: { autoAssign: false, dueDays: 2 },
  retentionDays: 365,
  notifications: { email: false, whatsapp: false, digest: "off" },
  bridges: { preferBridge: true },
};

const DESTINATIONS: Destination[] = ["tally", "excel", "google_sheets"];

const DOC_TYPES: DocType[] = [
  "supplier_invoice",
  "credit_note",
  "purchase_order",
  "goods_receipt",
  "e_way_bill",
  "e_invoice",
  "bank_statement",
];

function clampStage(value: unknown): TenantSettings["autonomy"]["stage"] {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_SETTINGS.autonomy.stage;
  return Math.max(0, Math.min(4, Math.round(number))) as TenantSettings["autonomy"]["stage"];
}

export function mergeSettings(input: unknown): TenantSettings {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<TenantSettings>;
  const thresholds = { ...DEFAULT_SETTINGS.thresholds };
  for (const destination of DESTINATIONS) {
    const stored = raw.thresholds?.[destination];
    if (stored) thresholds[destination] = { ...thresholds[destination], ...stored };
  }

  const docThresholds: TenantSettings["docThresholds"] = {};
  for (const docType of DOC_TYPES) {
    const stored = raw.docThresholds?.[docType];
    if (stored) docThresholds[docType] = { ...stored };
  }

  const docValueMinor: TenantSettings["limits"]["docValueMinor"] = {};
  for (const docType of DOC_TYPES) {
    const value = raw.limits?.docValueMinor?.[docType];
    if (typeof value === "number" && Number.isFinite(value)) docValueMinor[docType] = value;
  }

  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    thresholds,
    docThresholds,
    limits: {
      ...DEFAULT_SETTINGS.limits,
      ...(raw.limits ?? {}),
      docValueMinor,
    },
    gst: {
      ...DEFAULT_SETTINGS.gst,
      ...(raw.gst ?? {}),
      knownHsnRates: { ...DEFAULT_SETTINGS.gst.knownHsnRates, ...(raw.gst?.knownHsnRates ?? {}) },
    },
    pack: { ...DEFAULT_SETTINGS.pack, ...(raw.pack ?? {}) },
    autonomy: {
      ...DEFAULT_SETTINGS.autonomy,
      ...(raw.autonomy ?? {}),
      stage: clampStage(raw.autonomy?.stage ?? DEFAULT_SETTINGS.autonomy.stage),
    },
    permissions: {
      level: isPermissionLevel(raw.permissions?.level)
        ? raw.permissions.level
        : DEFAULT_SETTINGS.permissions.level,
      ceilingMinor:
        typeof raw.permissions?.ceilingMinor === "number" &&
        Number.isFinite(raw.permissions.ceilingMinor) &&
        raw.permissions.ceilingMinor >= 0
          ? Math.round(raw.permissions.ceilingMinor)
          : DEFAULT_SETTINGS.permissions.ceilingMinor,
    },
    review: { ...DEFAULT_SETTINGS.review, ...(raw.review ?? {}) },
    retentionDays:
      typeof raw.retentionDays === "number" && raw.retentionDays >= 30
        ? Math.round(raw.retentionDays)
        : DEFAULT_SETTINGS.retentionDays,
    notifications: { ...DEFAULT_SETTINGS.notifications, ...(raw.notifications ?? {}) },
    bridges: { ...DEFAULT_SETTINGS.bridges, ...(raw.bridges ?? {}) },
  };
}
