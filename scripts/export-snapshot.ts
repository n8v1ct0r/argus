// Exports a recorded window of the local store as static JSON for the static deploy
// (NEXT_PUBLIC_ARGUS_MODE=snapshot). Vercel cannot run the ingest worker or keep a libSQL file,
// so the deployed app reads these files instead of the API routes.
//
//   DATABASE_URL=file:./data/ship/capture.db node scripts/export-snapshot.ts [--out public/snapshot]
//
// Steps: write a DEMO template brief for the window (no model call), check it with the rule 4
// checker (exit 1 on any violation), answer the preset Ask questions the same way, then write
// every API payload the app reads for the window. Flight and fire payloads are content-addressed
// so identical frames are stored once.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AskResponse, BriefBullet, EventsPayload } from "../src/api/types.ts";
import { buildEventsPayload } from "../src/api/server/citations.ts";
import { buildFiresLayer } from "../src/api/server/fires.ts";
import { buildFlightsLayer } from "../src/api/server/flights.ts";
import { buildEventsLayer } from "../src/api/server/natural-events.ts";
import { buildQuakesLayer } from "../src/api/server/quakes.ts";
import { buildReplay } from "../src/api/server/replay.ts";
import { buildStatus } from "../src/api/server/status.ts";
import { buildFactsPack } from "../src/brief/facts.ts";
import { checkCited, latestBriefPayload } from "../src/brief/generate.ts";
import { RefTable, runTool } from "../src/ask/tools.ts";
import type { EventRecord } from "../src/events/types.ts";
import {
  COUNT_MIN_MAGNITUDE,
  TEMPLATE_MODEL,
  TEMPLATE_QUESTIONS,
  templateAnswer,
  templateBullets,
} from "../src/brief/template.ts";
import { migrate, openDb, type Db } from "../src/db/client.ts";
import { getEvents, listEvents } from "../src/db/queries.ts";
import { sha256Hex } from "../src/lib/digest.ts";
import { propagateGrid, type ElementSet } from "../src/satellites/propagate.ts";
import type { SnapshotManifest } from "../src/snapshot/types.ts";

const DAY = 24 * 3_600_000;
const FLIGHT_BUCKET = 10 * 60_000;
const FIRE_BUCKET = 3_600_000;
const SAT_STEP_MS = 300_000;
const MAX_IDS = 50;

function outDir(argv: string[]): string {
  const i = argv.indexOf("--out");
  return i !== -1 && argv[i + 1] ? argv[i + 1]! : "public/snapshot";
}

function write(dir: string, name: string, payload: unknown): number {
  const text = JSON.stringify(payload);
  writeFileSync(join(dir, name), text);
  return text.length;
}

/** Writes a payload under its content hash and returns the file name. */
function writeHashed(dir: string, sub: string, payload: unknown): string {
  const text = JSON.stringify(payload);
  const name = `${sub}/${sha256Hex(text).slice(0, 16)}.json`;
  writeFileSync(join(dir, name), text);
  return name;
}

/**
 * Counts quakes at or above COUNT_MIN_MAGNITUDE in the window through Ask Argus's own
 * count_events tool, which stores the count as a citable aggregate event with its members.
 */
async function countAggregate(db: Db, from: number, to: number): Promise<EventRecord | null> {
  const refs = new RefTable();
  const out = await runTool({ db, refs, now: to }, "count_events", {
    kinds: ["earthquake"],
    min_magnitude: COUNT_MIN_MAGNITUDE,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
  });
  if (out.isError) throw new Error(`count_events failed: ${out.content}`);
  const ref = (JSON.parse(out.content) as { aggregate: { id: string } }).aggregate.id;
  const id = refs.resolve(ref);
  return id ? ((await getEvents(db, [id]))[0] ?? null) : null;
}

async function storeTemplateBrief(db: Db, windowEnd: number, now: number) {
  const pack = await buildFactsPack(db, windowEnd);
  const events = await getEvents(db, pack.eventIds);
  const byId = new Map(events.map((e) => [e.id, e]));
  const aggregate = await countAggregate(db, pack.windowStart, pack.windowEnd);
  // The count leads: it cites every quake it counts, so opening it lights them all up.
  const ordered = [
    ...(aggregate && aggregate.facts.count?.value !== 0 ? [aggregate] : []),
    ...pack.eventIds.flatMap((id) => byId.get(id) ?? []),
  ];
  const bullets = templateBullets(ordered);
  const check = await checkCited(db, bullets);
  const id = `brief-${now}-${pack.digest.slice(0, 12)}-demo`;
  await db.execute({
    sql: `INSERT OR IGNORE INTO briefs (id, created_at, window_start, window_end, input_digest, model, bullets,
            check_result, status, input_tokens, output_tokens, cost_micros)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`,
    args: [
      id,
      now,
      pack.windowStart,
      pack.windowEnd,
      pack.digest,
      TEMPLATE_MODEL,
      JSON.stringify(bullets),
      JSON.stringify({ ...check, problems: [], attempts: 1 }),
      check.ok && bullets.length > 0 ? "published" : "failed",
    ],
  });
  return { bullets, check, ordered };
}

async function main(): Promise<number> {
  const dir = outDir(process.argv.slice(2));
  const db = await openDb();
  await migrate(db);

  // The window ends at the newest stored fetch, so the snapshot is the recording, not "now".
  const newest = await db.execute("SELECT MAX(fetched_at) AS t FROM events");
  const to = Number(newest.rows[0]?.t ?? 0);
  if (!to) {
    console.error("The store is empty. Run pnpm ingest first.");
    return 1;
  }
  const from = to - DAY;
  const firstFetch = await db.execute("SELECT MIN(fetched_at) AS t FROM events");
  const recordedFrom = Number(firstFetch.rows[0]?.t ?? from);

  const brief = await storeTemplateBrief(db, to, to);
  if (!brief.check.ok || brief.bullets.length === 0) {
    console.error("The template brief failed the number check:");
    for (const v of brief.check.violations) console.error(`  ${v.sentenceIndex + 1}: ${v.detail}`);
    return 1;
  }

  const ask: Array<{ question: string; response: AskResponse }> = [];
  for (const q of TEMPLATE_QUESTIONS) {
    const sentences: BriefBullet[] = templateAnswer(q, brief.ordered);
    if (!sentences.length) continue;
    const result = await checkCited(db, sentences);
    if (!result.ok) {
      console.error(`The answer to "${q.question}" failed the number check.`);
      return 1;
    }
    ask.push({
      question: q.question,
      response: { answer: { sentences, numbersChecked: result.numbersChecked } },
    });
  }

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "flights"), { recursive: true });
  mkdirSync(join(dir, "fires"), { recursive: true });

  const w = { from, to };
  write(dir, "status.json", await buildStatus(db, { now: to }));
  write(dir, "brief.json", await latestBriefPayload(db, to));
  write(dir, "replay.json", await buildReplay(db, { ...w, now: to }));
  const quakes = await buildQuakesLayer(db, w);
  write(dir, "quakes.json", quakes);
  const natural = await buildEventsLayer(db, { ...w, wildfires: false });
  write(dir, "events-layer.json", natural);
  write(dir, "ask.json", ask);

  // Satellites: the newest element set per satellite, propagated on the replay grid.
  const rows = await listEvents(db, { kinds: ["satellite_elements"], limit: 5000, order: "desc" });
  const sets = new Map<string, ElementSet>();
  for (const e of rows) {
    if (sets.has(e.recordKey) || !e.raw) continue;
    sets.set(e.recordKey, {
      id: e.id,
      name: e.facts.name?.text ?? e.recordKey,
      omm: JSON.parse(e.raw),
    });
  }
  const times: number[] = [];
  for (let t = from; t <= to; t += SAT_STEP_MS) times.push(t);
  write(dir, "satellites.json", propagateGrid([...sets.values()], times));

  // Flights every 10 minutes and fires every hour, as the app requests them.
  const flights: Record<string, string> = {};
  for (let at = Math.floor(from / FLIGHT_BUCKET) * FLIGHT_BUCKET; at <= to; at += FLIGHT_BUCKET) {
    const layer = await buildFlightsLayer(db, { at });
    if (layer.items.length) flights[String(at)] = writeHashed(dir, "flights", layer);
  }
  const fires: Record<string, string> = {};
  for (let at = Math.floor(from / FIRE_BUCKET) * FIRE_BUCKET; at <= to; at += FIRE_BUCKET) {
    const layer = await buildFiresLayer(db, { at });
    if (layer.items.length) fires[String(at)] = writeHashed(dir, "fires", layer);
  }

  // Every event the app can ask for: citations, their members, and anything a visitor can pick.
  const ids = new Set<string>();
  for (const b of brief.bullets) b.event_ids.forEach((id) => ids.add(id));
  for (const a of ask)
    a.response.answer?.sentences.forEach((s) => s.event_ids.forEach((id) => ids.add(id)));
  quakes.items.forEach((q) => ids.add(q.id));
  natural.items.forEach((e) => ids.add(e.id));
  const all = [...ids];
  const events: EventsPayload["events"] = [];
  for (let i = 0; i < all.length; i += MAX_IDS) {
    const page = await buildEventsPayload(db, { ids: all.slice(i, i + MAX_IDS) });
    events.push(...page.events);
  }
  write(dir, "events.json", Object.fromEntries(events.map((e) => [e.id, e])));

  const manifest: SnapshotManifest = {
    version: 1,
    windowFrom: from,
    windowTo: to,
    recordedFrom,
    exportedAt: Date.now(),
    briefModel: TEMPLATE_MODEL,
    flights,
    fires,
  };
  write(dir, "manifest.json", manifest);

  console.log(
    [
      `snapshot: ${dir}`,
      `window ${new Date(from).toISOString()} to ${new Date(to).toISOString()}`,
      `recorded from ${new Date(recordedFrom).toISOString()}`,
      `brief: ${brief.bullets.length} bullets, ${brief.check.numbersChecked} numbers checked, ${brief.check.violations.length} violations`,
      `ask: ${ask.length} preset answers`,
      `flights: ${Object.keys(flights).length} frames, fires: ${Object.keys(fires).length} hours`,
      `events: ${events.length} citable records`,
    ].join("\n"),
  );
  return 0;
}

process.exitCode = await main();
