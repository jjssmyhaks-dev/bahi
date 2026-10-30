import { env } from "./env.server";
import { adminClient, findOrCreateUser } from "./auth.server";
import { ensureDemoWorkspace } from "./demo.server";

export async function seedDemoWorkspace(): Promise<{ tenantId: string }> {
  if (!env.demoPassword) {
    throw new Error("DEMO_PASSWORD is not set, so the demo workspace cannot be created.");
  }

  const admin = adminClient();
  const listed = await admin.auth.admin.listUsers({ page: 1, perPage: 1_000 });
  if (listed.error) throw new Error(`Could not list auth users: ${listed.error.message}`);

  let authUser = listed.data.users.find(
    (user) => user.email?.toLowerCase() === env.demoEmail.toLowerCase(),
  );

  if (!authUser) {
    const created = await admin.auth.admin.createUser({
      email: env.demoEmail,
      password: env.demoPassword,
      email_confirm: true,
      user_metadata: { name: "Demo Owner" },
    });
    if (created.error || !created.data.user) {
      throw new Error(`Could not create the demo user: ${created.error?.message ?? "unknown"}`);
    }
    authUser = created.data.user;
  }

  const user = await findOrCreateUser(authUser, "Demo Owner");
  const tenant = await ensureDemoWorkspace(user.id, user.email);
  return { tenantId: tenant.id };
}
