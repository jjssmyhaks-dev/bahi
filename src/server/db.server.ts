import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { env } from "./env.server";

declare global {
  var __bahiPool: Pool | undefined;
}

export function getPool(): Pool {
  if (!globalThis.__bahiPool) {
    globalThis.__bahiPool = new Pool({
      connectionString: env.databaseUrl,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 12_000,
    });
    globalThis.__bahiPool.on("error", (err) => console.error("postgres pool error", err.message));
  }
  return globalThis.__bahiPool;
}

export async function sql<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function sqlOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await sql<T>(text, params);
  return rows[0] ?? null;
}

const SCHEMA_PATTERN = /^bahi_t_[a-z0-9_]{6,40}$/;

export function assertTenantSchema(schema: string): string {
  if (!SCHEMA_PATTERN.test(schema)) throw new Error("Invalid tenant schema");
  return schema;
}

/**
 * Returns a quoted, schema-qualified table name. The schema always comes from
 * the server session, never from request input.
 */
export function table(schema: string, name: string): string {
  if (!/^[a-z_]+$/.test(name)) throw new Error("Invalid table name");
  return `"${assertTenantSchema(schema)}"."${name}"`;
}
