import { mergeSettings } from "@/lib/settings";
import { isPermissionLevel } from "@/lib/permissions";
import type {
  AutonomyStage,
  Destination,
  DocType,
  PermissionLevel,
  SessionUser,
  TenantSettings,
} from "@/lib/types";
import { sql, sqlOne, table } from "./db.server";

export interface SettingsPatch {
  autonomyMode?: "draft" | "autonomous" | undefined;
  killSwitch?: boolean | undefined;
  thresholds?:
    | Partial<
        Record<
          Destination,
          { minConfidence?: number | undefined; allowWarnings?: boolean | undefined } | undefined
        >
      >
    | undefined;
  docThresholds?:
    Partial<Record<DocType, { minConfidence?: number; allowWarnings?: boolean }>> | undefined;
  limits?:
    | {
        autoPostValueMinor?: number | undefined;
        dailyPostCap?: number | undefined;
        docValueMinor?: Partial<Record<DocType, number>> | undefined;
      }
    | undefined;
  defaultDestination?: Destination | undefined;
  autonomy?: {
    stage?: AutonomyStage | undefined;
    shadowMode?: boolean | undefined;
    errorBudgetPct?: number | undefined;
  };
  review?: { autoAssign?: boolean | undefined; dueDays?: number | undefined } | undefined;
  retentionDays?: number | undefined;
  notifications?:
    | {
        email?: boolean | undefined;
        whatsapp?: boolean | undefined;
        digest?: "off" | "daily" | "weekly" | undefined;
      }
    | undefined;
  bridges?: { preferBridge?: boolean | undefined } | undefined;
  pack?: { key?: string | undefined; version?: string | undefined } | undefined;
  permissions?:
    | {
        level?: PermissionLevel | undefined;
        ceilingMinor?: number | undefined;
      }
    | undefined;
}

function clampConfidence(value: number): number {
  return Math.min(1, Math.max(0.5, Math.round(value * 1000) / 1000));
}

export async function updateWorkspaceSettings(
  session: SessionUser,
  patch: SettingsPatch,
): Promise<TenantSettings> {
  if (session.role !== "owner") {
    throw new Error("Only the workspace owner can change these settings.");
  }

  const thresholds: TenantSettings["thresholds"] = { ...session.settings.thresholds };
  for (const destination of Object.keys(thresholds) as Destination[]) {
    const incoming = patch.thresholds?.[destination];
    if (!incoming) continue;
    thresholds[destination] = {
      minConfidence:
        incoming.minConfidence === undefined
          ? thresholds[destination].minConfidence
          : clampConfidence(incoming.minConfidence),
      allowWarnings: incoming.allowWarnings ?? thresholds[destination].allowWarnings,
    };
  }

  const docThresholds: TenantSettings["docThresholds"] = {
    ...session.settings.docThresholds,
  };
  for (const [docType, incoming] of Object.entries(patch.docThresholds ?? {})) {
    if (!incoming) continue;
    docThresholds[docType as DocType] = {
      minConfidence:
        incoming.minConfidence === undefined
          ? (docThresholds[docType as DocType]?.minConfidence ?? 0.95)
          : clampConfidence(incoming.minConfidence),
      allowWarnings:
        incoming.allowWarnings ?? docThresholds[docType as DocType]?.allowWarnings ?? false,
    };
  }

  const docValueMinor: TenantSettings["limits"]["docValueMinor"] = {
    ...session.settings.limits.docValueMinor,
    ...(patch.limits?.docValueMinor ?? {}),
  };

  const requestedLevel = isPermissionLevel(patch.permissions?.level)
    ? patch.permissions.level
    : undefined;
  const currentLevel = session.settings.permissions.level;
  const level: PermissionLevel =
    requestedLevel ??
    (patch.autonomyMode === "draft"
      ? "ask"
      : patch.autonomyMode === "autonomous" && currentLevel === "ask"
        ? "auto"
        : currentLevel);
  const autonomyMode: "draft" | "autonomous" = level === "ask" ? "draft" : "autonomous";
  const ceilingMinor =
    patch.permissions?.ceilingMinor === undefined
      ? session.settings.permissions.ceilingMinor
      : Math.max(0, Math.round(patch.permissions.ceilingMinor));

  const settings = mergeSettings({
    ...session.settings,
    thresholds,
    docThresholds,
    limits: {
      ...session.settings.limits,
      ...(patch.limits ?? {}),
      docValueMinor,
    },
    defaultDestination: patch.defaultDestination ?? session.settings.defaultDestination,
    autonomy: { ...session.settings.autonomy, ...(patch.autonomy ?? {}) },
    review: { ...session.settings.review, ...(patch.review ?? {}) },
    retentionDays: patch.retentionDays ?? session.settings.retentionDays,
    notifications: { ...session.settings.notifications, ...(patch.notifications ?? {}) },
    bridges: { ...session.settings.bridges, ...(patch.bridges ?? {}) },
    pack: { ...session.settings.pack, ...(patch.pack ?? {}) },
    permissions: { level, ceilingMinor },
  });

  const autonomyStage = patch.autonomy?.stage ?? session.autonomyStage;
  const shadowMode = patch.autonomy?.shadowMode ?? session.shadowMode;
  const retentionDays = settings.retentionDays;
  const errorBudgetPct = settings.autonomy.errorBudgetPct;

  await sql(
    `update bahi.tenants
        set settings = $2::jsonb,
            autonomy_mode = coalesce($3, autonomy_mode),
            autonomy_stage = $4,
            shadow_mode = $5,
            retention_days = $6,
            error_budget_pct = $7,
            kill_switch = coalesce($8, kill_switch)
      where id = $1`,
    [
      session.tenantId,
      JSON.stringify(settings),
      autonomyMode,
      autonomyStage,
      shadowMode,
      retentionDays,
      errorBudgetPct,
      patch.killSwitch ?? null,
    ],
  );

  if (patch.autonomy?.stage !== undefined && patch.autonomy.stage !== session.autonomyStage) {
    await sql(
      `insert into ${table(session.schema, "autonomy_events")}
         (stage_from, stage_to, reason, metrics, created_by)
       values ($1, $2, $3, '{}'::jsonb, $4)`,
      [
        session.autonomyStage,
        patch.autonomy.stage,
        "Stage changed by the workspace owner.",
        session.userId,
      ],
    );
  }

  await sql(
    `insert into ${table(session.schema, "activity")} (user_id, action, detail) values ($1, 'settings.updated', $2::jsonb)`,
    [
      session.userId,
      JSON.stringify({
        autonomyMode,
        autonomyStage,
        shadowMode,
        killSwitch: patch.killSwitch ?? session.killSwitch,
        permissionLevel: level,
        permissionCeilingMinor: ceilingMinor,
        thresholds,
        docThresholds,
        limits: settings.limits,
        retentionDays,
        defaultDestination: settings.defaultDestination,
        pack: settings.pack,
      }),
    ],
  );

  return settings;
}

export interface SheetConnectionRow {
  id: string;
  spreadsheet_name: string;
  sheet_name: string;
  spreadsheet_id: string | null;
  spreadsheet_url: string | null;
  status: string;
  scope: string | null;
  last_synced_at: Date | null;
  created_at: Date;
}

export async function getSheetConnection(session: SessionUser): Promise<SheetConnectionRow | null> {
  return sqlOne<SheetConnectionRow>(
    `select id, spreadsheet_name, sheet_name, spreadsheet_id, spreadsheet_url, status, scope,
            last_synced_at, created_at
       from ${table(session.schema, "sheet_connections")}
      where provider = 'google_sheets' order by created_at asc limit 1`,
  );
}

/** Only a real OAuth connection can be marked connected; a demo row cannot. */
export async function reconnectSheet(session: SessionUser): Promise<void> {
  if (session.role === "viewer") throw new Error("Viewers cannot change connections.");
  const connection = await sqlOne<{ id: string; refresh_token_enc: string | null }>(
    `select id, refresh_token_enc from ${table(session.schema, "sheet_connections")}
      where provider = 'google_sheets' order by created_at asc limit 1`,
  );
  if (!connection) throw new Error("No Google Sheet connection exists for this workspace.");
  if (!connection.refresh_token_enc) {
    throw new Error("Connect Google Sheets with Google sign-in before reconnecting.");
  }
  await sql(
    `update ${table(session.schema, "sheet_connections")} set status = 'connected' where id = $1`,
    [connection.id],
  );
  await sql(
    `insert into ${table(session.schema, "activity")} (user_id, action, detail) values ($1, 'connection.reconnected', $2::jsonb)`,
    [session.userId, JSON.stringify({ provider: "google_sheets" })],
  );
}
