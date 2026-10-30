import { mergeSettings, DEFAULT_SETTINGS } from "@/lib/settings";
import type { SessionUser } from "@/lib/types";
import { processDocumentText } from "./agents/pipeline.server";
import { ensureVendorMaster } from "./agents/store.server";
import { sql, sqlOne, table } from "./db.server";
import { createSampleDocument } from "./documents.server";
import { SAMPLE_DOCUMENTS, type SampleDocument } from "./extraction";
import { insertSummaryMessage } from "./pipeline.server";
import { insertAssistantMessage, insertUserMessage } from "./repo.server";

const DEMO_SLUG = "shree-metals-works";
const DEMO_COMPANY = "Shree Metals Works";

const DEMO_SETTINGS = {
  ...DEFAULT_SETTINGS,
  thresholds: {
    tally: { minConfidence: 0.95, allowWarnings: true },
    excel: { minConfidence: 0.85, allowWarnings: true },
    google_sheets: { minConfidence: 0.85, allowWarnings: true },
  },
  limits: { ...DEFAULT_SETTINGS.limits, autoPostValueMinor: 50_000_000 },
  autonomy: { ...DEFAULT_SETTINGS.autonomy, stage: 3 as const, shadowMode: false },
};

interface TenantRef {
  id: string;
  schema_name: string;
}

async function loadDemoSession(userId: string, tenantId: string): Promise<SessionUser | null> {
  const row = await sqlOne<{
    name: string;
    email: string;
    role: SessionUser["role"];
    tenant_name: string;
    tenant_slug: string;
    schema_name: string;
    autonomy_mode: SessionUser["autonomyMode"];
    kill_switch: boolean;
    settings: unknown;
  }>(
    `select u.name, u.email, m.role, t.name as tenant_name, t.slug as tenant_slug,
            t.schema_name, t.autonomy_mode, t.kill_switch, t.settings
       from bahi.users u
       join bahi.memberships m on m.user_id = u.id and m.tenant_id = $2
       join bahi.tenants t on t.id = m.tenant_id
      where u.id = $1`,
    [userId, tenantId],
  );
  if (!row) return null;
  const settings = mergeSettings(row.settings);
  return {
    userId,
    tenantId,
    tenantName: row.tenant_name,
    tenantSlug: row.tenant_slug,
    role: row.role,
    name: row.name ?? "Demo Owner",
    email: row.email,
    schema: row.schema_name,
    autonomyMode: row.autonomy_mode,
    autonomyStage: settings.autonomy.stage,
    shadowMode: settings.autonomy.shadowMode,
    killSwitch: row.kill_switch,
    retentionDays: settings.retentionDays,
    errorBudgetPct: settings.autonomy.errorBudgetPct,
    permissionLevel: settings.permissions.level,
    settings,
  };
}

async function insertSeededDocument(session: SessionUser, chatId: string, sample: SampleDocument) {
  return createSampleDocument(session, chatId, sample);
}

async function seedSampleChat(
  session: SessionUser,
  input: { title: string; intro: string; samples: SampleDocument[] },
): Promise<string> {
  const schema = session.schema;
  const created = await sqlOne<{ id: string }>(
    `insert into ${table(schema, "chats")} (user_id, title) values ($1, $2) returning id`,
    [session.userId, input.title],
  );
  if (!created) throw new Error("Could not seed the conversation.");
  const chatId = created.id;

  await insertUserMessage(schema, chatId, input.intro, {
    kind: "text",
    attachments: input.samples.map((sample) => ({
      name: sample.filename,
      size: Buffer.byteLength(sample.text, "utf8"),
      mime: sample.mimeType,
    })),
  });

  const recordIds: string[] = [];
  const summaries: string[] = [];
  let processed = 0;
  let escalated = false;

  for (const sample of input.samples) {
    const document = await insertSeededDocument(session, chatId, sample);
    const outcome = await processDocumentText({
      session,
      chatId,
      document,
      text: sample.text,
      filename: sample.filename,
      ...(sample.confidenceOverrides ? { overrides: sample.confidenceOverrides } : {}),
      ...(sample.vendorStatus ? { vendorStatus: sample.vendorStatus } : {}),
    });
    recordIds.push(...outcome.records.map((record) => record.id));
    summaries.push(outcome.summary);
    processed += 1;
    if (outcome.escalated) escalated = true;
  }

  if (recordIds.length) {
    await insertSummaryMessage(schema, chatId, summaries.join("\n\n"), recordIds, {
      name: "Document reader",
      status: escalated ? "failed" : "ok",
      summary: `${processed} file${processed === 1 ? "" : "s"} · classifier, extractor, matcher · rule engine`,
    });
  }

  return chatId;
}

async function seedExceptionChat(session: SessionUser): Promise<void> {
  const schema = session.schema;
  const created = await sqlOne<{ id: string }>(
    `insert into ${table(schema, "chats")} (user_id, title) values ($1, 'Site photos') returning id`,
    [session.userId],
  );
  if (!created) return;
  const chatId = created.id;

  const filename = "site-scan-0421.jpg";
  await insertUserMessage(schema, chatId, "Here's the photo of the bill from the site office.", {
    kind: "text",
    attachments: [{ name: filename, size: 812_004, mime: "image/jpeg" }],
  });

  const error =
    "The photo was too blurry to read. Nothing was guessed — re-upload a clearer photo or paste the invoice details.";
  await sql(
    `insert into ${table(schema, "documents")}
      (chat_id, user_id, filename, mime_type, size_bytes, status, page_count, error, permission_level)
     values ($1, $2, $3, 'image/jpeg', 812004, 'needs_attention', 1, $4, $5)`,
    [chatId, session.userId, filename, error, session.permissionLevel],
  );

  await insertAssistantMessage(schema, chatId, error, { kind: "upload_result", documents: 1 });

  await sql(
    `insert into ${table(schema, "activity")} (user_id, action, detail) values ($1, 'document.needs_attention', $2::jsonb)`,
    [session.userId, JSON.stringify({ filename, reason: "Unreadable photo" })],
  );
}

const SEEDED_TITLES = ["October supplier invoices", "HDFC statement — October", "Site photos"];

const DEMO_VENDORS = [
  { name: "Deccan Steel Traders", gstin: "27AACCP9876D1Z1", ledger: "Deccan Steel Traders" },
  { name: "Apex Polymers Pvt Ltd", gstin: "29AAGCA5678K1Z1", ledger: "Apex Polymers Pvt Ltd" },
  { name: "Kirti Engineering Works", gstin: "27AAFCK2468M1Z2", ledger: "Kirti Engineering Works" },
  { name: "Bharat Fasteners", gstin: null, ledger: "Bharat Fasteners" },
];

async function seedVendorMasters(session: SessionUser): Promise<void> {
  for (const vendor of DEMO_VENDORS) await ensureVendorMaster(session.schema, vendor);
}

async function seedWorkspace(session: SessionUser): Promise<void> {
  const existing = await sqlOne<{ n: number }>(
    `select count(*)::int as n from ${table(session.schema, "records")}`,
  );
  if (Number(existing?.n ?? 0) > 0) {
    // Studios created before the matcher existed get their supplier masters backfilled once.
    await seedVendorMasters(session);
    return;
  }

  // A failed earlier attempt can leave conversations without records; clear them so retries stay clean.
  await sql(
    `delete from ${table(session.schema, "documents")}
      where chat_id in (select id from ${table(session.schema, "chats")} where title = any($1::text[]))`,
    [SEEDED_TITLES],
  );
  await sql(`delete from ${table(session.schema, "chats")} where title = any($1::text[])`, [
    SEEDED_TITLES,
  ]);

  await seedVendorMasters(session);

  // Seeded newest-last so the supplier invoice conversation sits at the top of the list.
  await seedExceptionChat(session);

  await seedSampleChat(session, {
    title: "HDFC statement — October",
    intro: "Here's this month's HDFC current account statement. Put the lines into Google Sheets.",
    samples: SAMPLE_DOCUMENTS.filter((sample) => sample.id === "bank-statement"),
  });

  await seedSampleChat(session, {
    title: "October supplier invoices",
    intro:
      "These three supplier invoices came in today. Please enter the ones that are clean into Tally and show me anything that needs a second look.",
    samples: SAMPLE_DOCUMENTS.filter((sample) => sample.id !== "bank-statement"),
  });
}

/**
 * Creates the demo tenant once and seeds conversations that show every path:
 * a clean invoice posted automatically, two records held for review, bank
 * statement lines written to a sheet, and one unreadable photo in exceptions.
 */
export async function ensureDemoWorkspace(userId: string, email: string): Promise<{ id: string }> {
  const membership = await sqlOne<TenantRef>(
    `select t.id, t.schema_name from bahi.memberships m
       join bahi.tenants t on t.id = m.tenant_id
      where m.user_id = $1 order by m.created_at asc limit 1`,
    [userId],
  );

  let tenant: TenantRef | undefined = membership ?? undefined;

  if (!tenant) {
    const existing = await sqlOne<TenantRef>(
      `select id, schema_name from bahi.tenants where slug = $1`,
      [DEMO_SLUG],
    );
    if (existing) {
      await sql(
        `insert into bahi.memberships (tenant_id, user_id, role) values ($1, $2, 'owner')
         on conflict (tenant_id, user_id) do nothing`,
        [existing.id, userId],
      );
      tenant = existing;
    } else {
      const { bootstrapWorkspace } = await import("./auth.server");
      const created = await bootstrapWorkspace({
        userId,
        email,
        name: "Demo Owner",
        companyName: DEMO_COMPANY,
        autonomyMode: "autonomous",
        killSwitch: false,
        settings: DEMO_SETTINGS,
      });
      tenant = { id: created.id, schema_name: created.schemaName };
    }
  }

  const session = await loadDemoSession(userId, tenant.id);
  if (session) await seedWorkspace(session);

  return { id: tenant.id };
}
