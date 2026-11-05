// Plan section 7: "Every query uses an index, enforced by an EXPLAIN QUERY PLAN test." Runs the
// unit suite with ARGUS_SQL_LOG set, so every database client records the text of each statement
// it runs (never its arguments), then explains each distinct statement against a fresh schema
// and fails on any full table scan.
//
//   node scripts/check-indexes.ts
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { migrate, openDb } from "../src/db/client.ts";

const ROOT = join(import.meta.dirname, "..");
const LOG = join(ROOT, "data", "sql-log.txt");

mkdirSync(dirname(LOG), { recursive: true });
rmSync(LOG, { force: true });
const run = spawnSync("pnpm", ["exec", "playwright", "test", "--project=unit", "--reporter=dot"], {
  cwd: ROOT,
  env: { ...process.env, ARGUS_SQL_LOG: LOG },
  stdio: ["ignore", "ignore", "inherit"],
});
if (run.status !== 0) {
  console.error("check-indexes: the unit suite failed, so the statement list is incomplete.");
  process.exit(1);
}

// One entry per statement shape: an IN list of any length reads as IN (?).
const shapes = new Set(
  readFileSync(LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((sql) => sql.replace(/IN \((?:\?,\s*)*\?\)/g, "IN (?)")),
);
const NOT_QUERIES = /^(PRAGMA|CREATE|DROP|ALTER|BEGIN|COMMIT|ROLLBACK|EXPLAIN)\b/i;

/** Full scans allowed on purpose, each with the bound that keeps it cheap. */
const ALLOWED: Array<{ scan: RegExp; sql?: RegExp; why: string }> = [
  {
    scan: /^SCAN \(subquery-\d+\)$/,
    why: "reads a materialized subquery's result; the query inside it is checked on its own",
  },
  {
    scan: /^SCAN fire_presence$/,
    why: "at most firePresenceDays plus a few days times 2 satellites rows",
  },
  {
    scan: /^SCAN event_links\b/,
    sql: /NOT EXISTS \(SELECT 1 FROM events e WHERE e\.id = event_links\.parent_id\)/,
    why: "the hourly retention sweep for orphan links; retention keeps the table small",
  },
  {
    scan: /^SCAN briefs\b/,
    sql: /^SELECT id, status, bullets FROM briefs ORDER BY created_at, id$/,
    why: "scripts/check-briefs.ts audits every stored brief; retention keeps 48 h of briefs",
  },
];

const db = await openDb(":memory:");
await migrate(db);
const scans: string[] = [];
let checked = 0;
for (const sql of [...shapes].sort()) {
  if (NOT_QUERIES.test(sql)) continue;
  const args = Array<null>((sql.match(/\?/g) ?? []).length).fill(null);
  const plan = await db.execute({ sql: `EXPLAIN QUERY PLAN ${sql}`, args });
  checked += 1;
  for (const row of plan.rows) {
    const detail = String(row.detail ?? row[3] ?? "");
    // SEARCH is a bounded lookup. SCAN visits every row, of the table or of a whole index
    // ("SCAN t USING COVERING INDEX i" still reads all of i), so any SCAN of a table fails.
    if (!/^SCAN /.test(detail) || /CONSTANT ROW|VIRTUAL TABLE/.test(detail)) continue;
    if (ALLOWED.some((a) => a.scan.test(detail) && (!a.sql || a.sql.test(sql)))) continue;
    scans.push(`${detail}\n    in: ${sql}`);
  }
}

for (const s of scans) console.log(`full scan: ${s}`);
console.log(
  `check-indexes: ${scans.length} full table scans in ${checked} statements (${shapes.size} recorded).`,
);
process.exit(scans.length ? 1 : 0);
