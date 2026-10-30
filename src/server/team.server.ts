import { createHash, randomBytes } from "node:crypto";

import type { Role, SessionUser } from "@/lib/types";
import { startSessionFor } from "./auth.server";
import { env } from "./env.server";
import { sql, sqlOne, table } from "./db.server";
import { listMembers, type WorkspaceMember } from "./review.server";

export interface InviteRow {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

const ROLES: Role[] = ["owner", "reviewer", "viewer"];
const INVITE_DAYS = 7;

const hashInvite = (token: string) => createHash("sha256").update(token).digest("hex");

function assertOwner(session: SessionUser): void {
  if (session.role !== "owner") {
    throw new Error("Only the workspace owner can manage the team.");
  }
}

export async function listTeam(session: SessionUser): Promise<WorkspaceMember[]> {
  return listMembers(session);
}

export async function listInvites(session: SessionUser): Promise<InviteRow[]> {
  if (session.role !== "owner") return [];
  const rows = await sql<{
    id: string;
    email: string;
    role: Role;
    expires_at: Date;
    accepted_at: Date | null;
    created_at: Date;
  }>(
    `select id, email, role, expires_at, accepted_at, created_at
       from bahi.invites
      where tenant_id = $1 and accepted_at is null and expires_at > now()
      order by created_at desc`,
    [session.tenantId],
  );
  return rows.map((row) => ({
    id: String(row.id),
    email: row.email,
    role: row.role,
    expiresAt: new Date(row.expires_at).toISOString(),
    acceptedAt: row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

export async function inviteMember(
  session: SessionUser,
  input: { email: string; role: Role },
): Promise<{ invite: InviteRow; link: string; token: string }> {
  assertOwner(session);
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Enter a valid email address.");
  }
  if (!ROLES.includes(input.role)) throw new Error("Choose a valid role.");

  const existing = await sqlOne<{ user_id: string }>(
    `select m.user_id from bahi.memberships m join bahi.users u on u.id = m.user_id
      where m.tenant_id = $1 and lower(u.email) = $2`,
    [session.tenantId, email],
  );
  if (existing) throw new Error("That person is already in this workspace.");

  await sql(
    `delete from bahi.invites where tenant_id = $1 and lower(email) = $2 and accepted_at is null`,
    [session.tenantId, email],
  );

  const token = `bhai_inv_${randomBytes(24).toString("hex")}`;
  const row = await sqlOne<{
    id: string;
    email: string;
    role: Role;
    expires_at: Date;
    created_at: Date;
  }>(
    `insert into bahi.invites (tenant_id, email, role, token_hash, invited_by, expires_at)
     values ($1, $2, $3, $4, $5, now() + ($6::int * interval '1 day'))
     returning id, email, role, expires_at, created_at`,
    [session.tenantId, email, input.role, hashInvite(token), session.userId, INVITE_DAYS],
  );
  if (!row) throw new Error("The invite could not be created.");

  await sql(
    `insert into ${table(session.schema, "activity")} (user_id, action, detail)
     values ($1, 'team.invited', $2::jsonb)`,
    [session.userId, JSON.stringify({ email, role: input.role })],
  );

  return {
    invite: {
      id: String(row.id),
      email: row.email,
      role: row.role,
      expiresAt: new Date(row.expires_at).toISOString(),
      acceptedAt: null,
      createdAt: new Date(row.created_at).toISOString(),
    },
    link: `${env.appBaseUrl}/invite?token=${token}`,
    token,
  };
}

export async function revokeInvite(session: SessionUser, inviteId: string): Promise<void> {
  assertOwner(session);
  await sql(`delete from bahi.invites where id = $1 and tenant_id = $2`, [
    inviteId,
    session.tenantId,
  ]);
}

async function ownerCount(tenantId: string): Promise<number> {
  const row = await sqlOne<{ n: number }>(
    `select count(*)::int as n from bahi.memberships where tenant_id = $1 and role = 'owner'`,
    [tenantId],
  );
  return Number(row?.n ?? 0);
}

export async function changeMemberRole(
  session: SessionUser,
  input: { userId: string; role: Role },
): Promise<void> {
  assertOwner(session);
  if (!ROLES.includes(input.role)) throw new Error("Choose a valid role.");
  const member = await sqlOne<{ role: Role }>(
    `select role from bahi.memberships where tenant_id = $1 and user_id = $2`,
    [session.tenantId, input.userId],
  );
  if (!member) throw new Error("That person is not in this workspace.");
  if (
    member.role === "owner" &&
    input.role !== "owner" &&
    (await ownerCount(session.tenantId)) <= 1
  ) {
    throw new Error("Every workspace needs an owner. Promote someone else first.");
  }
  await sql(`update bahi.memberships set role = $3 where tenant_id = $1 and user_id = $2`, [
    session.tenantId,
    input.userId,
    input.role,
  ]);
  await sql(
    `insert into ${table(session.schema, "activity")} (user_id, action, detail)
     values ($1, 'team.role_changed', $2::jsonb)`,
    [session.userId, JSON.stringify({ userId: input.userId, role: input.role })],
  );
}

export async function removeMember(session: SessionUser, userId: string): Promise<void> {
  assertOwner(session);
  if (userId === session.userId) {
    throw new Error("You cannot remove yourself from the workspace.");
  }
  const member = await sqlOne<{ role: Role }>(
    `select role from bahi.memberships where tenant_id = $1 and user_id = $2`,
    [session.tenantId, userId],
  );
  if (!member) throw new Error("That person is not in this workspace.");
  if (member.role === "owner" && (await ownerCount(session.tenantId)) <= 1) {
    throw new Error("Every workspace needs an owner. Promote someone else first.");
  }
  await sql(`delete from bahi.memberships where tenant_id = $1 and user_id = $2`, [
    session.tenantId,
    userId,
  ]);
  await sql(
    `insert into ${table(session.schema, "activity")} (user_id, action, detail)
     values ($1, 'team.member_removed', $2::jsonb)`,
    [session.userId, JSON.stringify({ userId })],
  );
}

export async function acceptInvite(
  session: SessionUser,
  token: string,
): Promise<{ tenantName: string }> {
  const clean = token.trim();
  if (!clean.startsWith("bhai_inv_")) throw new Error("That invite link is not valid.");

  const invite = await sqlOne<{
    id: string;
    tenant_id: string;
    email: string;
    role: Role;
    accepted_at: Date | null;
    expires_at: Date;
    tenant_name: string;
    tenant_status: string;
  }>(
    `select i.id, i.tenant_id, i.email, i.role, i.accepted_at, i.expires_at,
            t.name as tenant_name, t.status as tenant_status
       from bahi.invites i join bahi.tenants t on t.id = i.tenant_id
      where i.token_hash = $1`,
    [hashInvite(clean)],
  );
  if (!invite) throw new Error("That invite link is not valid.");
  if (invite.accepted_at) throw new Error("That invite has already been used.");
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    throw new Error("That invite has expired. Ask the owner for a new one.");
  }
  if (invite.tenant_status !== "active") throw new Error("That workspace is no longer active.");
  if (invite.email.toLowerCase() !== session.email.toLowerCase()) {
    throw new Error(`This invite was sent to ${invite.email}. Sign in with that address.`);
  }

  await sql(
    `insert into bahi.memberships (tenant_id, user_id, role)
     values ($1, $2, $3)
     on conflict (tenant_id, user_id) do nothing`,
    [invite.tenant_id, session.userId, invite.role],
  );
  await sql(`update bahi.invites set accepted_at = now() where id = $1`, [invite.id]);
  await startSessionFor(session.userId, invite.tenant_id);
  return { tenantName: invite.tenant_name };
}
