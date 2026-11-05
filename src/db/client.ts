// One libSQL client for the local SQLite file (dev, tests, CI, screenshots) and, at deploy,
// hosted Turso. Same client, different URL.
import { createClient, type Client } from "@libsql/client";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.ts";

export type Db = Client;

const DEFAULT_URL = "file:./data/argus.db";

export function databaseUrl(): string {
  return process.env.DATABASE_URL || DEFAULT_URL;
}

/** Opens the database, creating the directory for a local file. Call migrate() before use. */
export async function openDb(
  url: string = databaseUrl(),
  authToken = process.env.DATABASE_AUTH_TOKEN,
): Promise<Db> {
  if (url.startsWith("file:")) {
    const path = url.slice("file:".length);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  }
  const db = createClient({ url, ...(authToken ? { authToken } : {}) });
  const sqlLog = process.env.ARGUS_SQL_LOG;
  if (sqlLog) recordStatements(db, sqlLog);
  if (url.startsWith("file:")) {
    // The worker and the Next server both write the local file.
    await db.execute("PRAGMA journal_mode = WAL");
    await db.execute("PRAGMA busy_timeout = 5000");
  }
  return db;
}

/**
 * For scripts/check-indexes.ts: appends the text of every statement the product code runs through
 * this client (never its arguments) to `path`, one per line, for EXPLAIN QUERY PLAN.
 */
function recordStatements(db: Client, path: string): void {
  const seen = new Set<string>();
  const record = (stmt: unknown) => {
    const text = typeof stmt === "string" ? stmt : (stmt as { sql?: unknown } | null)?.sql;
    if (typeof text !== "string") return;
    // Only statements the product runs: the nearest caller outside this file must not be a test.
    const caller = new Error().stack
      ?.split("\n")
      .slice(1)
      .find((line) => line.includes("file://") && !line.includes("/src/db/client.ts"));
    if (!caller || caller.includes("/tests/")) return;
    const sql = text.replace(/\s+/g, " ").trim();
    if (seen.has(sql)) return;
    seen.add(sql);
    appendFileSync(path, `${sql}\n`);
  };
  // Pass every argument through unchanged; only the statement text is looked at.
  const execute = db.execute.bind(db) as (...args: unknown[]) => unknown;
  const batch = db.batch.bind(db) as (...args: unknown[]) => unknown;
  Object.assign(db, {
    execute: (...args: unknown[]) => {
      record(args[0]);
      return execute(...args);
    },
    batch: (...args: unknown[]) => {
      if (Array.isArray(args[0])) for (const stmt of args[0]) record(stmt);
      return batch(...args);
    },
  });
}

export async function migrate(db: Db): Promise<void> {
  const rs = await db.execute("PRAGMA user_version");
  const from = Number(rs.rows[0]?.[0] ?? 0);
  if (from > 0 && from < SCHEMA_VERSION) {
    // No upgrade path before the first release: every table can be rebuilt from the sources.
    throw new Error(
      `The database uses schema ${from} and this code needs ${SCHEMA_VERSION}. ` +
        "Start from a new database file; pnpm ingest rebuilds it from the sources.",
    );
  }
  await db.executeMultiple(SCHEMA_SQL);
  await db.execute(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

let shared: Promise<Db> | null = null;

/** Process-wide client for route handlers and the worker. */
export function getDb(): Promise<Db> {
  shared ??= openDb().then(async (db) => {
    await migrate(db);
    return db;
  });
  return shared;
}
