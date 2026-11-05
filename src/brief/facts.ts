// The facts pack (docs/plan.md section 3d): what the brief model sees. Code picks the live
// detections of the last 24 h (quake clusters and fire growth first, then a few circling
// aircraft), then notable events (largest quakes, newest non-wildfire EONET events), up to
// config.brief.maxEventsInFactsPack items, in a deterministic order.
//
// Each item carries only { id, kind, detector?, facts: { key: text } }: no titles, no raw, no
// meta. `id` is a pack reference ("E1" upward), never the stored version id, because a circling
// detection's id contains the aircraft digest; `eventIds` maps each reference back.
import type { InValue } from "@libsql/client";
import { config } from "../../argus.config.ts";
import type { Db } from "../db/client.ts";
import { rowToEvent } from "../db/queries.ts";
import type { EventRecord, Kind } from "../events/types.ts";
import { canonicalJson, sha256Hex } from "../lib/digest.ts";
import { MS_PER_HOUR } from "../lib/time.ts";

export const BRIEF_WINDOW_MS = 24 * MS_PER_HOUR;

export type DetectorName = "quake_cluster" | "fire_growth" | "circling";

/** Plain names the model reads for each detector. */
export const DETECTOR_LABELS: Record<DetectorName, string> = {
  quake_cluster: "earthquake cluster",
  fire_growth: "heat detection growth",
  circling: "circling aircraft",
};

export interface FactsPackItem {
  /** Pack reference the model cites ("E1", "E2", ...). */
  id: string;
  kind: Kind;
  /** For detections: which detector found it. */
  detector?: string;
  /** Fact name to its exact display text. */
  facts: Record<string, string>;
}

export interface FactsPack {
  windowStart: number;
  windowEnd: number;
  items: FactsPackItem[];
  /** eventIds[i] is the stored version id behind items[i]. */
  eventIds: string[];
  /** sha256 of the items and the version ids behind them: equal data gives an equal digest. */
  digest: string;
}

/** Kinds that hold aircraft positions. They never reach a model, a tool result, or a citation. */
export function isAircraftKind(kind: Kind): boolean {
  return kind === "flight_frame" || kind === "aircraft_track";
}

/** True for version ids of flight records (their ids can contain an aircraft digest). */
export function isFlightId(id: string): boolean {
  return id.startsWith("flights:");
}

export function detectorOf(e: EventRecord): DetectorName | null {
  if (e.kind !== "detection") return null;
  const d = e.meta?.detector;
  if (d === "quake-cluster") return "quake_cluster";
  if (d === "fire-growth") return "fire_growth";
  if (d === "circling") return "circling";
  return null;
}

/** Facts as { name: text }, names sorted, without titles or member lists. */
export function factTexts(e: EventRecord): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(e.facts).sort()) {
    const text = e.facts[key]?.text;
    if (key === "title" || key === "members" || typeof text !== "string") continue;
    out[key] = text;
  }
  return out;
}

const COLUMNS_WITHOUT_RAW =
  "id, record_key, source, kind, occurred_at, fetched_at, source_updated_at, lat, lon, min_lat, min_lon, max_lat, max_lon, title, facts, meta, NULL AS raw, NULL AS raw_gz, raw_digest, fetch_id, supersedes";
const IN_CHUNK = 400;

/** Same order as latestVersion() in src/db/queries.ts: fetched_at, then source_updated_at. */
function isNewer(a: EventRecord, b: EventRecord): boolean {
  if (a.fetchedAt !== b.fetchedAt) return a.fetchedAt > b.fetchedAt;
  const ua = a.sourceUpdatedAt ?? 0;
  const ub = b.sourceUpdatedAt ?? 0;
  if (ua !== ub) return ua > ub;
  return a.id > b.id;
}

/**
 * The live version of each record as of `asOf`: the newest version fetched by then, left out when
 * that version is an ended record (meta.deleted === true). Raw is not loaded.
 */
export async function currentVersions(
  db: Db,
  recordKeys: Iterable<string>,
  asOf: number,
): Promise<Map<string, EventRecord>> {
  const keys = [...new Set(recordKeys)];
  const newest = new Map<string, EventRecord>();
  for (let i = 0; i < keys.length; i += IN_CHUNK) {
    const chunk = keys.slice(i, i + IN_CHUNK);
    const args: InValue[] = [...chunk, asOf];
    const rs = await db.execute({
      sql: `SELECT ${COLUMNS_WITHOUT_RAW} FROM events WHERE record_key IN (${chunk
        .map(() => "?")
        .join(",")}) AND fetched_at <= ?`,
      args,
    });
    for (const row of rs.rows) {
      const e = rowToEvent(row);
      const prev = newest.get(e.recordKey);
      if (!prev || isNewer(e, prev)) newest.set(e.recordKey, e);
    }
  }
  for (const [key, e] of newest) if (e.meta?.deleted === true) newest.delete(key);
  return newest;
}

/** Events of these kinds that occurred in [from, to], without raw. */
export async function scanEvents(
  db: Db,
  kinds: Kind[],
  from: number,
  to: number,
  limit: number,
): Promise<EventRecord[]> {
  if (!kinds.length) return [];
  const rs = await db.execute({
    sql: `SELECT ${COLUMNS_WITHOUT_RAW} FROM events WHERE kind IN (${kinds
      .map(() => "?")
      .join(",")}) AND occurred_at >= ? AND occurred_at <= ? ORDER BY occurred_at DESC LIMIT ?`,
    args: [...kinds, from, to, limit],
  });
  return rs.rows.map(rowToEvent);
}

function byId(a: EventRecord, b: EventRecord): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function numberFact(e: EventRecord, key: string): number {
  const v = e.facts[key]?.value;
  return typeof v === "number" && Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;
}

function isWildfire(e: EventRecord): boolean {
  const categories = e.meta?.categories;
  if (Array.isArray(categories)) {
    for (const c of categories) {
      if (c && typeof c === "object" && (c as { id?: unknown }).id === "wildfires") return true;
    }
  }
  return /wildfire/i.test(e.facts.category?.text ?? "");
}

/** Rows scanned per kind; far above a 48-hour store's size. */
const SCAN_LIMIT = 100_000;

/** Live detections found or occurring in the window, grouped and ordered for the brief. */
async function packDetections(db: Db, from: number, to: number): Promise<EventRecord[]> {
  // A fire-growth detection is dated at local solar noon of its second day, up to about a day
  // before it can be scored, so detections found in the window count too.
  const rows = await scanEvents(db, ["detection"], from - BRIEF_WINDOW_MS, to, SCAN_LIMIT);
  const current = await currentVersions(
    db,
    rows.map((e) => e.recordKey),
    to,
  );
  const live = [...current.values()].filter(
    (e) => e.kind === "detection" && Math.max(e.occurredAt, e.fetchedAt) >= from,
  );
  const group = (name: DetectorName) => live.filter((e) => detectorOf(e) === name);
  const clusters = group("quake_cluster").sort(
    (a, b) =>
      numberFact(b, "count") - numberFact(a, "count") || b.occurredAt - a.occurredAt || byId(a, b),
  );
  const growth = group("fire_growth").sort(
    (a, b) => numberFact(b, "growth_pct") - numberFact(a, "growth_pct") || byId(a, b),
  );
  const circling = group("circling")
    .sort((a, b) => b.occurredAt - a.occurredAt || byId(a, b))
    .slice(0, config.detectors.circling.maxCirclingInBrief);
  return [...clusters, ...growth, ...circling];
}

async function liveInWindow(db: Db, kind: Kind, from: number, to: number) {
  const rows = await scanEvents(db, [kind], from, to, SCAN_LIMIT);
  const current = await currentVersions(
    db,
    rows.map((e) => e.recordKey),
    to,
  );
  return [...current.values()].filter(
    (e) => e.kind === kind && e.occurredAt >= from && e.occurredAt <= to,
  );
}

/** Largest earthquakes first (quarry blasts and other non-quake types left out). */
async function notableQuakes(db: Db, from: number, to: number): Promise<EventRecord[]> {
  const types: readonly string[] = config.detectors.quakeCluster.quakeTypes;
  return (await liveInWindow(db, "earthquake", from, to))
    .filter((e) => types.includes(e.facts.type?.text ?? "") && e.facts.mag !== undefined)
    .sort(
      (a, b) =>
        numberFact(b, "mag") - numberFact(a, "mag") || b.occurredAt - a.occurredAt || byId(a, b),
    );
}

/** Newest non-wildfire natural events first (FIRMS covers fires). */
async function notableNaturalEvents(db: Db, from: number, to: number): Promise<EventRecord[]> {
  return (await liveInWindow(db, "natural_event", from, to))
    .filter((e) => !isWildfire(e))
    .sort((a, b) => b.occurredAt - a.occurredAt || byId(a, b));
}

/** Pack reference for position i: "E1" upward. */
export function packRef(i: number): string {
  return `E${i + 1}`;
}

export async function buildFactsPack(db: Db, windowEnd: number): Promise<FactsPack> {
  const windowStart = windowEnd - BRIEF_WINDOW_MS;
  const max = config.brief.maxEventsInFactsPack;
  const detections = (await packDetections(db, windowStart, windowEnd)).slice(0, max);

  const room = max - detections.length;
  const quakes = await notableQuakes(db, windowStart, windowEnd);
  const natural = await notableNaturalEvents(db, windowStart, windowEnd);
  // Half the room each; whatever one side cannot fill goes to the other.
  let quakeCount = Math.min(quakes.length, Math.ceil(room / 2));
  const naturalCount = Math.min(natural.length, room - quakeCount);
  quakeCount = Math.min(quakes.length, room - naturalCount);

  const chosen: EventRecord[] = [];
  const seen = new Set<string>();
  for (const e of [
    ...detections,
    ...quakes.slice(0, quakeCount),
    ...natural.slice(0, naturalCount),
  ]) {
    if (seen.has(e.id) || isAircraftKind(e.kind)) continue;
    seen.add(e.id);
    chosen.push(e);
  }

  const items: FactsPackItem[] = chosen.map((e, i) => {
    const detector = detectorOf(e);
    return {
      id: packRef(i),
      kind: e.kind,
      ...(detector ? { detector: DETECTOR_LABELS[detector] } : {}),
      facts: factTexts(e),
    };
  });
  const eventIds = chosen.map((e) => e.id);
  const digest = sha256Hex(canonicalJson({ items, eventIds }));
  return { windowStart, windowEnd, items, eventIds, digest };
}
