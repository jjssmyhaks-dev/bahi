import type { JsonObject, JsonValue, SessionUser } from "@/lib/types";
import { updateWorkspaceSettings } from "./settings.server";
import { sql, sqlOne, table } from "./db.server";

export interface PackRow {
  key: string;
  version: string;
  name: string;
  industry: string;
  status: "draft" | "published" | "retired";
  config: JsonObject;
  createdAt: string;
}

export interface PackOverrideRow {
  id: string;
  packKey: string;
  patch: JsonObject;
  status: "proposed" | "confirmed" | "retired";
  createdAt: string;
}

export interface PackState {
  packs: PackRow[];
  active: { key: string; version: string } | null;
  override: PackOverrideRow | null;
  effectiveConfig: JsonObject;
}

export function mergePackConfig(base: JsonObject, patch: JsonObject): JsonObject {
  const merged: JsonObject = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    // Overrides are owner-supplied JSON; never let a key reach the prototype.
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const current = merged[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current &&
      typeof current === "object" &&
      !Array.isArray(current)
    ) {
      merged[key] = mergePackConfig(current as JsonObject, value as JsonObject);
    } else {
      merged[key] = value as JsonValue;
    }
  }
  return merged;
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number(part) || 0);
  const right = b.split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function listPacks(): Promise<PackRow[]> {
  const rows = await sql<{
    key: string;
    version: string;
    name: string;
    industry: string;
    status: PackRow["status"];
    config: JsonObject;
    created_at: Date;
  }>(
    `select key, version, name, industry, status, config, created_at
       from bahi.packs where status = 'published'`,
  );
  return rows
    .map((row) => ({
      key: row.key,
      version: row.version,
      name: row.name,
      industry: row.industry,
      status: row.status,
      config: row.config ?? {},
      createdAt: new Date(row.created_at).toISOString(),
    }))
    .sort((a, b) => a.key.localeCompare(b.key) || compareVersions(b.version, a.version));
}

async function activeOverride(schema: string, packKey: string): Promise<PackOverrideRow | null> {
  const row = await sqlOne<{
    id: string;
    pack_key: string;
    patch: JsonObject;
    status: PackOverrideRow["status"];
    created_at: Date;
  }>(
    `select id, pack_key, patch, status, created_at
       from ${table(schema, "pack_overrides")}
      where pack_key = $1 and status = 'confirmed'`,
    [packKey],
  );
  if (!row) return null;
  return {
    id: String(row.id),
    packKey: row.pack_key,
    patch: row.patch ?? {},
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function getPackState(session: SessionUser): Promise<PackState> {
  const packs = await listPacks();
  const wanted = session.settings.pack;
  const active =
    packs.find((pack) => pack.key === wanted.key && pack.version === wanted.version) ??
    packs.find((pack) => pack.key === wanted.key) ??
    packs[0] ??
    null;
  const override = active ? await activeOverride(session.schema, active.key) : null;
  return {
    packs,
    active: active ? { key: active.key, version: active.version } : null,
    override,
    effectiveConfig: mergePackConfig(active?.config ?? {}, override?.patch ?? {}),
  };
}

function assertOwner(session: SessionUser): void {
  if (session.role !== "owner") {
    throw new Error("Only the workspace owner can change the pack.");
  }
}

export async function setPackVersion(
  session: SessionUser,
  input: { key: string; version: string },
): Promise<PackState> {
  assertOwner(session);
  const row = await sqlOne<{ name: string }>(
    `select name from bahi.packs where key = $1 and version = $2 and status = 'published'`,
    [input.key, input.version],
  );
  if (!row) throw new Error("That pack version is not published.");
  session.settings = await updateWorkspaceSettings(session, {
    pack: { key: input.key, version: input.version },
  });
  await sql(
    `insert into ${table(session.schema, "activity")} (user_id, action, detail)
     values ($1, 'pack.activated', $2::jsonb)`,
    [session.userId, JSON.stringify({ key: input.key, version: input.version })],
  );
  return getPackState(session);
}

/**
 * Rolls back to the newest published version below the tenant's current one.
 * Rolling forward again is an explicit choice in the UI.
 */
export async function rollbackPack(session: SessionUser): Promise<PackState> {
  assertOwner(session);
  const packs = await listPacks();
  const current = session.settings.pack;
  const candidates = packs
    .filter(
      (pack) => pack.key === current.key && compareVersions(pack.version, current.version) < 0,
    )
    .sort((a, b) => compareVersions(b.version, a.version));
  const target = candidates[0];
  if (!target) {
    throw new Error("There is no earlier published version to roll back to.");
  }
  session.settings = await updateWorkspaceSettings(session, {
    pack: { key: target.key, version: target.version },
  });
  await sql(
    `insert into ${table(session.schema, "activity")} (user_id, action, detail)
     values ($1, 'pack.rolled_back', $2::jsonb)`,
    [
      session.userId,
      JSON.stringify({
        key: target.key,
        from: current.version,
        to: target.version,
      }),
    ],
  );
  return getPackState(session);
}

export async function savePackOverride(
  session: SessionUser,
  input: { packKey: string; patch: JsonObject },
): Promise<PackState> {
  assertOwner(session);
  const pack = await sqlOne<{ key: string }>(
    `select key from bahi.packs where key = $1 and status = 'published' limit 1`,
    [input.packKey],
  );
  if (!pack) throw new Error("That pack is not published.");

  const patch = input.patch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("The override has to be a JSON object.");
  }
  const encoded = JSON.stringify(patch);
  if (encoded.length > 20_000) throw new Error("The override is too large.");

  await sql(
    `insert into ${table(session.schema, "pack_overrides")}
       (pack_key, patch, status, created_by)
     values ($1, $2::jsonb, 'confirmed', $3)
     on conflict (pack_key) do update
       set patch = excluded.patch, status = 'confirmed', created_by = excluded.created_by`,
    [input.packKey, encoded, session.userId],
  );
  await sql(
    `insert into ${table(session.schema, "activity")} (user_id, action, detail)
     values ($1, 'pack.override_saved', $2::jsonb)`,
    [session.userId, JSON.stringify({ packKey: input.packKey })],
  );
  return getPackState(session);
}

export async function clearPackOverride(session: SessionUser, packKey: string): Promise<PackState> {
  assertOwner(session);
  await sql(`delete from ${table(session.schema, "pack_overrides")} where pack_key = $1`, [
    packKey,
  ]);
  return getPackState(session);
}
