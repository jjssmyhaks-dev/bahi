import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Run with: node --env-file=.env scripts/migrate.mjs");
  process.exit(1);
}

const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const dir = path.join(process.cwd(), "supabase", "migrations");
const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

await client.query(`create schema if not exists bahi`);
await client.query(`
  create table if not exists bahi.schema_migrations (
    filename text primary key,
    applied_at timestamptz not null default now()
  )
`);

for (const file of files) {
  const { rowCount } = await client.query(
    "select 1 from bahi.schema_migrations where filename = $1",
    [file],
  );
  if (rowCount) {
    console.log(`skip ${file}`);
    continue;
  }
  const sql = await readFile(path.join(dir, file), "utf8");
  await client.query("begin");
  try {
    await client.query(sql);
    await client.query("insert into bahi.schema_migrations (filename) values ($1)", [file]);
    await client.query("commit");
    console.log(`applied ${file}`);
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

await client.end();
console.log("migrations complete");
