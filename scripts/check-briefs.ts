// Rule 4 checker CLI (docs/plan.md section 3d): re-runs checkSentences on every published brief
// against the stored event versions it cites. Failed briefs are never served, so they are
// counted and skipped. Exits 1 on any violation.
//
//   node scripts/check-briefs.ts [--db file:./data/argus.db]
//
// It never calls a model: it imports only the store and the checker.
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { checkSentences, type Sentence } from "../src/check/check-brief.ts";
import { databaseUrl, migrate, openDb, type Db } from "../src/db/client.ts";
import { getEvents } from "../src/db/queries.ts";
import { isAircraftKind } from "../src/brief/facts.ts";

export interface BriefsCheckSummary {
  briefsChecked: number;
  failedBriefsSkipped: number;
  numbersChecked: number;
  unresolvedCitations: number;
  violations: number;
  /** One line per violation: brief id, bullet, kind, detail. */
  lines: string[];
}

function parseBullets(text: string): Sentence[] | null {
  try {
    const list: unknown = JSON.parse(text);
    if (!Array.isArray(list)) return null;
    const out: Sentence[] = [];
    for (const x of list) {
      if (typeof x !== "object" || x === null) return null;
      const { text: t, event_ids: ids } = x as Record<string, unknown>;
      if (typeof t !== "string" || !Array.isArray(ids)) return null;
      out.push({ text: t, event_ids: ids.filter((id): id is string => typeof id === "string") });
    }
    return out;
  } catch {
    return null;
  }
}

export async function checkStoredBriefs(db: Db): Promise<BriefsCheckSummary> {
  const summary: BriefsCheckSummary = {
    briefsChecked: 0,
    failedBriefsSkipped: 0,
    numbersChecked: 0,
    unresolvedCitations: 0,
    violations: 0,
    lines: [],
  };
  const rs = await db.execute("SELECT id, status, bullets FROM briefs ORDER BY created_at, id");
  for (const row of rs.rows) {
    const id = String(row.id);
    if (String(row.status) !== "published") {
      summary.failedBriefsSkipped++;
      continue;
    }
    summary.briefsChecked++;
    const bullets = parseBullets(String(row.bullets));
    if (!bullets) {
      summary.violations++;
      summary.lines.push(`${id}: bullets are not readable JSON`);
      continue;
    }
    const cited = [...new Set(bullets.flatMap((b) => b.event_ids))];
    const events = (await getEvents(db, cited)).filter((e) => !isAircraftKind(e.kind));
    const result = checkSentences(bullets, new Map(events.map((e) => [e.id, e])));
    summary.numbersChecked += result.numbersChecked;
    for (const v of result.violations) {
      summary.violations++;
      if (v.kind === "unresolved_id") summary.unresolvedCitations++;
      summary.lines.push(`${id} bullet ${v.sentenceIndex + 1}: ${v.kind}: ${v.detail}`);
    }
  }
  return summary;
}

function dbArg(argv: string[]): string {
  const i = argv.findIndex((a) => a === "--db" || a.startsWith("--db="));
  if (i === -1) return databaseUrl();
  const arg = argv[i] ?? "";
  const value = arg.startsWith("--db=") ? arg.slice("--db=".length) : argv[i + 1];
  if (!value) throw new Error("--db needs a database URL, such as file:./data/argus.db");
  return value;
}

async function main(): Promise<number> {
  const url = dbArg(process.argv.slice(2));
  if (url.startsWith("file:")) {
    const path = url.slice("file:".length);
    if (path !== ":memory:" && !existsSync(path)) {
      console.error(`No database at ${path}. Pass --db file:path/to/argus.db.`);
      return 1;
    }
  }
  const db = await openDb(url);
  await migrate(db);
  const s = await checkStoredBriefs(db);
  for (const line of s.lines) console.log(line);
  console.log(`Briefs checked: ${s.briefsChecked}`);
  console.log(`Failed briefs skipped (never served): ${s.failedBriefsSkipped}`);
  console.log(`Numbers checked: ${s.numbersChecked}`);
  console.log(`Unresolved citations: ${s.unresolvedCitations}`);
  console.log(`Violations: ${s.violations}`);
  db.close();
  return s.violations > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
