import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { AutonomyStage, Destination, FieldMap, JsonObject, SessionUser } from "@/lib/types";
import {
  resolveSession,
  requireSession,
  signIn,
  signInDemo,
  signOut,
  signUp,
} from "@/server/auth.server";
import {
  actOnRecord,
  getChatPayload,
  ingestFiles,
  newChat,
  saveFields,
  sendMessage,
  startSample,
} from "@/server/chat.server";
import { getDocumentUrl } from "@/server/documents.server";
import { parseDate, SAMPLE_DOCUMENTS } from "@/server/extraction";
import {
  buildExcelBase64,
  buildTallyVoucher,
  describeDestinationPayload,
  tallyXml,
} from "@/server/posting.server";
import {
  getQueueCounts,
  getQueueMetrics,
  getRecord,
  listActivity,
  listChats,
  listExceptions,
  listPosts,
  listQueue,
  listSheetRows,
} from "@/server/repo.server";
import {
  answerReviewRequest,
  assignRecord,
  bulkRecordAction,
  listMembers,
  listReviewRequests,
  requestReviewInput,
} from "@/server/review.server";
import { autonomyStatus } from "@/server/autonomy.server";
import { getInsights } from "@/server/insights.server";
import {
  clearPackOverride,
  getPackState,
  rollbackPack,
  savePackOverride,
  setPackVersion,
} from "@/server/packs.server";
import {
  acceptInvite,
  changeMemberRole,
  inviteMember,
  listInvites,
  listTeam,
  removeMember,
  revokeInvite,
} from "@/server/team.server";
import { listJobs, purgeTenantRetention } from "@/server/jobs.server";
import {
  createIntakeSource,
  deleteIntakeSource,
  listIntakeEvents,
  listIntakeSources,
  setIntakeSourceStatus,
} from "@/server/intake.server";
import { updateWorkspaceSettings } from "@/server/settings.server";
import { getWorkspace } from "@/server/repo.server";
import { getSheetConnection, reconnectSheet } from "@/server/settings.server";
import { chooseSpreadsheet, googleSheetHealth } from "@/server/google.server";
import { activeExcelTemplate, fillExcelTemplate, uploadExcelTemplate } from "@/server/excel.server";
import { importGstr2b, latestGstr2bImport } from "@/server/gstr2b.server";
import { visionEnabled, visionModelName } from "@/server/vision.server";
import { rollbackWrite } from "@/server/workflow.server";
import {
  bridgeHealth,
  bridgeSigningEnabled,
  createBridgeAgent,
  listBridgeAgents,
  listBridgeCommands,
  revokeBridgeAgent,
} from "@/server/bridge.server";
import {
  confirmSheetMapping,
  curateNow,
  getAgentConsole,
  reviewProposal,
} from "@/server/agents/admin.server";

export type Viewer = Omit<SessionUser, "schema">;

const DESTINATION = z.enum(["tally", "excel", "google_sheets"]);
const MONEY_FIELDS = new Set([
  "total",
  "taxable_value",
  "cgst",
  "sgst",
  "igst",
  "round_off",
  "debit",
  "credit",
  "balance",
]);

async function viewerFromSession(): Promise<Viewer | null> {
  const session = await resolveSession();
  if (!session) return null;
  const { schema: _schema, ...viewer } = session;
  return viewer;
}

export const getViewerFn = createServerFn({ method: "GET" }).handler(async () =>
  viewerFromSession(),
);

export const loginFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ email: z.string().trim().min(3), password: z.string().min(1) }).parse(input),
  )
  .handler(async ({ data }) => signIn(data));

export const signupFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        name: z.string().trim().min(1).max(80),
        company: z.string().trim().min(1).max(120),
        email: z.string().trim().min(3),
        password: z.string().min(8).max(200),
      })
      .parse(input),
  )
  .handler(async ({ data }) => signUp(data));

export const demoLoginFn = createServerFn({ method: "POST" }).handler(async () => signInDemo());

export const logoutFn = createServerFn({ method: "POST" }).handler(async () => {
  await signOut();
  return { ok: true };
});

export const workspaceFn = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireSession();
  return getWorkspace(session);
});

export const chatsFn = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireSession();
  return listChats(session.schema, session.userId);
});

export const chatFn = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => z.object({ chatId: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const session = await requireSession();
    return getChatPayload(session, data.chatId);
  });

export const newChatFn = createServerFn({ method: "POST" }).handler(async () => {
  const session = await requireSession();
  return { chatId: await newChat(session) };
});

export const sendMessageFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({ chatId: z.string().min(1).optional(), text: z.string().trim().min(1).max(8000) })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    return sendMessage(session, {
      ...(data.chatId ? { chatId: data.chatId } : {}),
      text: data.text,
    });
  });

export const uploadFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        chatId: z.string().min(1).optional(),
        note: z.string().max(2000).optional(),
        destination: DESTINATION.optional(),
        files: z
          .array(
            z.object({
              name: z.string().min(1).max(200),
              mimeType: z.string().max(120),
              base64: z.string().min(1).max(20_000_000),
            }),
          )
          .min(1)
          .max(8),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    return ingestFiles(session, {
      ...(data.chatId ? { chatId: data.chatId } : {}),
      files: data.files,
      ...(data.note ? { note: data.note } : {}),
      ...(data.destination ? { destination: data.destination } : {}),
    });
  });

export const startSampleFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ chatId: z.string().min(1).optional(), sampleId: z.string().min(1) }).parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    return startSample(session, {
      ...(data.chatId ? { chatId: data.chatId } : {}),
      sampleId: data.sampleId,
    });
  });

export const samplesFn = createServerFn({ method: "GET" }).handler(async () =>
  SAMPLE_DOCUMENTS.map((sample) => ({
    id: sample.id,
    label: sample.label,
    description: sample.description,
    filename: sample.filename,
    docType: sample.expectedType,
  })),
);

export const queueFn = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z
      .object({
        status: z
          .enum(["open", "pending_review", "held", "posted", "written", "rejected", "failed"])
          .optional(),
        docType: z
          .enum([
            "supplier_invoice",
            "credit_note",
            "purchase_order",
            "goods_receipt",
            "e_way_bill",
            "e_invoice",
            "bank_statement",
          ])
          .optional(),
        destination: DESTINATION.optional(),
        reason: z.enum(["fail", "warn", "confidence", "unassigned", "overdue"]).optional(),
        assignedTo: z.string().uuid().optional(),
        ageDays: z.number().int().min(1).max(365).optional(),
        groupKey: z.string().max(200).optional(),
        search: z.string().trim().max(120).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    const filters = {
      ...(data.status ? { status: data.status } : {}),
      ...(data.docType ? { docType: data.docType } : {}),
      ...(data.destination ? { destination: data.destination } : {}),
      ...(data.reason ? { reason: data.reason } : {}),
      ...(data.assignedTo ? { assignedTo: data.assignedTo } : {}),
      ...(data.ageDays ? { ageDays: data.ageDays } : {}),
      ...(data.groupKey ? { groupKey: data.groupKey } : {}),
      ...(data.search ? { search: data.search } : {}),
    };
    const [records, counts, metrics, members] = await Promise.all([
      listQueue(session.schema, filters),
      getQueueCounts(session.schema),
      getQueueMetrics(session.schema),
      listMembers(session),
    ]);
    return { records, counts, metrics, members };
  });

export const recordActionFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        recordId: z.string().uuid(),
        action: z.enum(["approve", "reject", "hold"]),
        destination: DESTINATION.optional(),
        reason: z.string().max(600).optional(),
        note: z.string().max(600).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    return actOnRecord(session, {
      recordId: data.recordId,
      action: data.action,
      ...(data.destination ? { destination: data.destination } : {}),
      ...(data.reason ? { reason: data.reason } : {}),
      ...(data.note ? { note: data.note } : {}),
    });
  });

export const assignRecordFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        recordId: z.string().uuid(),
        userId: z.string().uuid().nullable(),
        dueAt: z.string().datetime({ offset: true }).nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    await assignRecord(session, data);
    return { ok: true };
  });

export const requestReviewFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        recordId: z.string().uuid(),
        kind: z.enum(["document", "clarification"]),
        message: z.string().trim().min(1).max(600),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    return requestReviewInput(session, data);
  });

export const answerReviewFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        requestId: z.string().uuid(),
        answer: z.string().trim().min(1).max(1000),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    return answerReviewRequest(session, data.requestId, data.answer);
  });

export const bulkActionFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        recordIds: z.array(z.string().uuid()).min(1).max(25),
        action: z.enum(["approve", "reject", "hold"]),
        destination: DESTINATION.optional(),
        reason: z.string().max(600).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    return bulkRecordAction(session, {
      recordIds: data.recordIds,
      action: data.action,
      ...(data.destination ? { destination: data.destination } : {}),
      ...(data.reason ? { reason: data.reason } : {}),
    });
  });

export const destinationPreviewFn = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => z.object({ recordId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const session = await requireSession();
    const record = await getRecord(session.schema, data.recordId);
    if (!record) throw new Error("Record not found.");
    return { payload: describeDestinationPayload(record, session.tenantName) };
  });

export const insightsFn = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireSession();
  return getInsights(session);
});

const ROLE = z.enum(["owner", "reviewer", "viewer"]);

export const platformFn = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireSession();
  const [packs, team, invites, intakeSources, intakeEvents, jobs] = await Promise.all([
    getPackState(session),
    listTeam(session),
    listInvites(session),
    listIntakeSources(session),
    listIntakeEvents(session),
    listJobs(session.tenantId),
  ]);
  return { packs, team, invites, intakeSources, intakeEvents, jobs };
});

export const setPackFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({ key: z.string().trim().min(1).max(80), version: z.string().trim().min(1).max(40) })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    return setPackVersion(session, data);
  });

export const rollbackPackFn = createServerFn({ method: "POST" }).handler(async () => {
  const session = await requireSession();
  return rollbackPack(session);
});

export const savePackOverrideFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        packKey: z.string().trim().min(1).max(80),
        patch: z.record(z.unknown()),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    return savePackOverride(session, {
      packKey: data.packKey,
      patch: data.patch as JsonObject,
    });
  });

export const clearPackOverrideFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ packKey: z.string().min(1).max(80) }).parse(input))
  .handler(async ({ data }) => {
    const session = await requireSession();
    return clearPackOverride(session, data.packKey);
  });

export const inviteMemberFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ email: z.string().trim().min(3).max(200), role: ROLE }).parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    return inviteMember(session, data);
  });

export const revokeInviteFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ inviteId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const session = await requireSession();
    await revokeInvite(session, data.inviteId);
    return { ok: true };
  });

export const changeRoleFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ userId: z.string().uuid(), role: ROLE }).parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    await changeMemberRole(session, data);
    return { ok: true };
  });

export const removeMemberFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ userId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const session = await requireSession();
    await removeMember(session, data.userId);
    return { ok: true };
  });

export const acceptInviteFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ token: z.string().trim().min(10).max(200) }).parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    return acceptInvite(session, data.token);
  });

export const createIntakeSourceFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        channel: z.enum(["email", "whatsapp"]),
        address: z.string().trim().min(3).max(200),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    return createIntakeSource(session, data);
  });

export const setIntakeSourceStatusFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ sourceId: z.string().uuid(), status: z.enum(["active", "paused"]) }).parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    await setIntakeSourceStatus(session, data);
    return { ok: true };
  });

export const deleteIntakeSourceFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ sourceId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const session = await requireSession();
    await deleteIntakeSource(session, data.sourceId);
    return { ok: true };
  });

export const purgeRetentionFn = createServerFn({ method: "POST" }).handler(async () => {
  const session = await requireSession();
  if (session.role !== "owner") {
    throw new Error("Only the workspace owner can purge stored documents.");
  }
  return purgeTenantRetention(session.tenantId);
});

export const reverseEntryFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ recordId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const session = await requireSession();
    const record = await getRecord(session.schema, data.recordId);
    if (!record) throw new Error("That record is not in this workspace.");
    const outcome = await rollbackWrite(session, record.id, record.destination);
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.data;
  });

function normaliseFields(raw: Record<string, string | number | null>): FieldMap {
  const fields: FieldMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === "") continue;
    if (MONEY_FIELDS.has(key)) {
      const parsed =
        typeof value === "number" ? value : Number(String(value).replace(/[₹,\s]/g, ""));
      fields[key] = Number.isFinite(parsed) ? parsed : 0;
    } else if (key === "invoice_date") {
      fields[key] = parseDate(String(value)) ?? String(value);
    } else {
      fields[key] = String(value);
    }
  }
  return fields;
}

export const saveFieldsFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        recordId: z.string().uuid(),
        fields: z.record(z.union([z.string(), z.number(), z.null()])),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    return saveFields(session, data.recordId, normaliseFields(data.fields));
  });

export const recordDetailFn = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => z.object({ recordId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const session = await requireSession();
    const record = await getRecord(session.schema, data.recordId);
    if (!record) throw new Error("Record not found.");
    const [posts, requests, members] = await Promise.all([
      listPosts(session.schema, record.id),
      listReviewRequests(session.schema, record.id),
      listMembers(session),
    ]);
    return { record, posts, requests, members };
  });

export const activityFn = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireSession();
  return { activity: await listActivity(session.schema) };
});

export const exceptionsFn = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireSession();
  return { documents: await listExceptions(session.schema) };
});

export const documentUrlFn = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => z.object({ documentId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const session = await requireSession();
    return { url: await getDocumentUrl(session, data.documentId) };
  });

export const settingsFn = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireSession();
  const [sheet, google, excelTemplate, gstr2b, autonomy] = await Promise.all([
    getSheetConnection(session),
    googleSheetHealth(session),
    activeExcelTemplate(session),
    latestGstr2bImport(session),
    autonomyStatus(session),
  ]);
  return {
    settings: session.settings,
    userId: session.userId,
    autonomyMode: session.autonomyMode,
    autonomyStage: session.autonomyStage,
    shadowMode: session.shadowMode,
    killSwitch: session.killSwitch,
    permissionLevel: session.permissionLevel,
    role: session.role,
    sheet: sheet
      ? {
          id: sheet.id,
          spreadsheetName: sheet.spreadsheet_name,
          sheetName: sheet.sheet_name,
          status: sheet.status,
          connectedAt: sheet.created_at.toISOString(),
        }
      : null,
    google,
    excelTemplate,
    gstr2b,
    autonomy,
    vision: { enabled: visionEnabled(), model: visionModelName() },
  };
});

export const updateSettingsFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        autonomyMode: z.enum(["draft", "autonomous"]).optional(),
        killSwitch: z.boolean().optional(),
        thresholds: z
          .object({
            tally: z
              .object({
                minConfidence: z.number().min(0.5).max(1).optional(),
                allowWarnings: z.boolean().optional(),
              })
              .optional(),
            excel: z
              .object({
                minConfidence: z.number().min(0.5).max(1).optional(),
                allowWarnings: z.boolean().optional(),
              })
              .optional(),
            google_sheets: z
              .object({
                minConfidence: z.number().min(0.5).max(1).optional(),
                allowWarnings: z.boolean().optional(),
              })
              .optional(),
          })
          .optional(),
        limits: z
          .object({
            autoPostValueMinor: z.number().int().min(0).max(10_000_000_000).optional(),
            dailyPostCap: z.number().int().min(1).max(500).optional(),
          })
          .optional(),
        defaultDestination: DESTINATION.optional(),
        autonomy: z
          .object({
            stage: z.number().int().min(0).max(4).optional(),
            shadowMode: z.boolean().optional(),
            errorBudgetPct: z.number().min(0).max(100).optional(),
          })
          .optional(),
        review: z
          .object({
            autoAssign: z.boolean().optional(),
            dueDays: z.number().int().min(0).max(90).optional(),
          })
          .optional(),
        permissions: z
          .object({
            level: z.enum(["ask", "auto", "full"]).optional(),
            ceilingMinor: z.number().int().min(0).max(10_000_000_000).optional(),
          })
          .optional(),
        retentionDays: z.number().int().min(30).max(3650).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    const { autonomy: autonomyPatch, ...rest } = data;
    const autonomy = autonomyPatch
      ? (() => {
          const { stage, ...settings } = autonomyPatch;
          return {
            ...settings,
            ...(stage !== undefined ? { stage: stage as AutonomyStage } : {}),
          };
        })()
      : undefined;
    return updateWorkspaceSettings(session, {
      ...rest,
      ...(autonomy ? { autonomy } : {}),
    });
  });

export const reconnectSheetFn = createServerFn({ method: "POST" }).handler(async () => {
  const session = await requireSession();
  await reconnectSheet(session);
  return { ok: true };
});

export const chooseSpreadsheetFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        spreadsheet: z.string().trim().min(10).max(500),
        sheetName: z.string().trim().max(100).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    return chooseSpreadsheet(session, data);
  });

export const uploadExcelTemplateFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        name: z.string().trim().min(1).max(160),
        mimeType: z
          .string()
          .trim()
          .max(160)
          .default("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        base64: z.string().min(16).max(16_000_000),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    return uploadExcelTemplate(session, data);
  });

export const importGstr2bFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        name: z.string().trim().min(1).max(160),
        content: z.string().min(2).max(8_000_000),
        period: z
          .string()
          .trim()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
          .optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    return importGstr2b(session, {
      name: data.name,
      content: data.content,
      ...(data.period ? { period: data.period } : {}),
    });
  });

export const bridgeFn = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireSession();
  const [agents, health, commands] = await Promise.all([
    listBridgeAgents(session),
    bridgeHealth(session),
    listBridgeCommands(session, 20),
  ]);
  return {
    agents,
    health,
    commands,
    signed: bridgeSigningEnabled(),
  };
});

export const createBridgeAgentFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        label: z.string().trim().min(1).max(80),
        companyName: z.string().trim().min(1).max(120),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    return createBridgeAgent(session, data);
  });

export const revokeBridgeAgentFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ agentId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const session = await requireSession();
    await revokeBridgeAgent(session, data.agentId);
    return { ok: true };
  });

export const sheetRowsFn = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireSession();
  const connection = await getSheetConnection(session);
  const rows = await listSheetRows(session.schema);
  return {
    connection: connection
      ? {
          spreadsheetName: connection.spreadsheet_name,
          sheetName: connection.sheet_name,
          status: connection.status,
        }
      : null,
    rows,
  };
});

export const agentsFn = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireSession();
  return getAgentConsole(session);
});

export const runCuratorFn = createServerFn({ method: "POST" }).handler(async () => {
  const session = await requireSession();
  return curateNow(session);
});

export const reviewProposalFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        proposalId: z.string().uuid(),
        decision: z.enum(["confirmed", "ignored"]),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    return reviewProposal(session, data.proposalId, data.decision);
  });

const COLUMN_MAPPING = z.object({
  column: z.string().trim().min(1).max(120),
  field: z.string().max(80).nullable(),
  fixedValue: z.string().max(120).nullable(),
  confidence: z.number().min(0).max(1),
});

export const confirmSheetMappingFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ columns: z.array(COLUMN_MAPPING).min(1).max(80) }).parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    return confirmSheetMapping(session, data.columns);
  });

export const exportExcelFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ recordIds: z.array(z.string().uuid()).max(200).optional() }).parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    let records = data.recordIds?.length
      ? (await Promise.all(data.recordIds.map((id) => getRecord(session.schema, id)))).filter(
          (record): record is NonNullable<typeof record> => Boolean(record),
        )
      : await listQueue(session.schema, {});
    if (!records.length) records = await listQueue(session.schema, { status: "written" });
    if (!records.length) throw new Error("There is nothing to export yet.");
    const filled = await fillExcelTemplate(session, records);
    if (filled) {
      return {
        filename: filled.filename,
        base64: filled.base64,
        count: records.length,
        template: true,
      };
    }
    const base64 = await buildExcelBase64(records);
    return {
      filename: `bahi-entries-${new Date().toISOString().slice(0, 10)}.xlsx`,
      base64,
      count: records.length,
      template: false,
    };
  });

export const tallyXmlFn = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => z.object({ recordId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const session = await requireSession();
    const record = await getRecord(session.schema, data.recordId);
    if (!record) throw new Error("Record not found.");
    const xml = tallyXml(buildTallyVoucher(record, session.tenantName));
    const safe = record.title.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40);
    return { filename: `${safe || "voucher"}.xml`, xml };
  });

export type { Destination };
