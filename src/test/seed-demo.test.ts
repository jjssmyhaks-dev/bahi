import { describe, expect, it } from "vitest";

import { env } from "@/server/env.server";
import { adminClient } from "@/server/auth.server";
import { sql, sqlOne } from "@/server/db.server";
import { ensureDemoWorkspace } from "@/server/demo.server";

// Hits the live database; run explicitly with BAHI_SEED=1 npm test.
describe.runIf(process.env["BAHI_SEED"] === "1")("demo workspace", () => {
  it("creates and seeds the demo workspace", async () => {
    const admin = adminClient();
    let userId: string | undefined;

    const created = await admin.auth.admin.createUser({
      email: env.demoEmail,
      password: env.demoPassword,
      email_confirm: true,
      user_metadata: { name: "Demo Owner" },
    });
    if (created.data.user) userId = created.data.user.id;
    if (!userId) {
      const listed = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      userId = listed.data.users.find((user) => user.email === env.demoEmail)?.id;
    }
    expect(userId).toBeTruthy();

    const local = await sqlOne<{ id: string }>(
      `insert into bahi.users (auth_id, email, name) values ($1, $2, 'Demo Owner')
       on conflict (auth_id) do update set email = excluded.email returning id`,
      [userId!, env.demoEmail],
    );
    const tenant = await ensureDemoWorkspace(local!.id, env.demoEmail);
    expect(tenant.id).toBeTruthy();

    const row = await sqlOne<{ schema_name: string }>(
      `select schema_name from bahi.tenants where id = $1`,
      [tenant.id],
    );
    const schema = row!.schema_name;

    const chats = await sql<{ title: string }>(
      `select title from "${schema}".chats order by updated_at desc`,
    );
    const records = await sql<{
      title: string;
      status: string;
      destination: string;
      destination_ref: string | null;
    }>(
      `select title, status, destination, destination_ref from "${schema}".records order by created_at asc`,
    );
    const rows = await sql(`select row_number from "${schema}".sheet_rows order by row_number`);
    const docs = await sql<{ status: string }>(`select status from "${schema}".documents`);

    console.log(
      "chats",
      chats.map((chat) => chat.title),
    );
    console.log("records", records);
    console.log("sheet rows", rows.length, "documents", docs.length);

    expect(chats.length).toBeGreaterThanOrEqual(3);
    expect(records.some((record) => record.status === "posted")).toBe(true);
    expect(records.some((record) => record.status === "pending_review")).toBe(true);
    expect(records.some((record) => record.status === "written")).toBe(true);
    expect(rows.length).toBe(3);
    expect(docs.some((doc) => doc.status === "needs_attention")).toBe(true);
  }, 60_000);
});
