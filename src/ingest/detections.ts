// Stores detector output and wires each detector to its stored inputs (docs/plan.md 3a to 3c).
// Every detection goes through storeDetections: an id that already exists is skipped, a new
// version points at the newest stored version of the same record, and its members become
// event_links. Detections are pure functions of their inputs, so re-running a detector over
// unchanged data stores nothing.
import { config } from "../../argus.config.ts";
import type { Db } from "../db/client.ts";
import { insertEvents, latestVersion, linkEvents, rowToEvent, type Writer } from "../db/queries.ts";
import { detectCircling, type CirclingHit } from "../detectors/circling.ts";
import { detectQuakeClusters } from "../detectors/quake-cluster.ts";
import type { DetectionResult, FlightSample } from "../detectors/types.ts";
import type { EventRecord } from "../events/types.ts";
import { MS_PER_MINUTE, MS_PER_SECOND } from "../detectors/units.ts";
import { MS_PER_HOUR } from "../lib/time.ts";
import { fireGrowthDue } from "./sources/firms.ts";
import { buildAircraftTrack } from "./sources/flights/frames.ts";

/** What one detector pass did, for the worker's run line. */
export interface DetectorRun {
  /** Inputs examined: quakes, scored day pairs, or flight samples. */
  examined: number;
  /** Detections the detector returned (after the worker's own filters). */
  found: number;
  /** New detection versions stored. */
  stored: number;
  /** Detections or findings left out, with the reason in `note`. */
  skipped: number;
  note?: string;
}

async function exists(db: Db, id: string): Promise<boolean> {
  const rs = await db.execute({ sql: "SELECT 1 FROM events WHERE id = ?", args: [id] });
  return rs.rows.length > 0;
}

async function hasLinks(db: Db, parentId: string): Promise<boolean> {
  const rs = await db.execute({
    sql: "SELECT 1 FROM event_links WHERE parent_id = ? LIMIT 1",
    args: [parentId],
  });
  return rs.rows.length > 0;
}

/**
 * Stores detections in order. An id that is already stored is skipped (it only gets its links
 * back if a crash left it without them). A new id supersedes the newest stored version of its
 * record, and its members are linked after the insert. Returns how many detections were new.
 */
export async function storeDetections(
  db: Db,
  results: DetectionResult[],
  writer: Writer = "ingest",
  now = Date.now(),
): Promise<number> {
  let stored = 0;
  for (const { detection, members } of results) {
    if (await exists(db, detection.id)) {
      if (members.length && !(await hasLinks(db, detection.id))) {
        await linkEvents(db, detection.id, members, writer, now);
      }
      continue;
    }
    const prev = await latestVersion(db, detection.recordKey);
    const version: EventRecord = { ...detection, supersedes: prev?.id ?? null };
    stored += await insertEvents(db, [version], writer, now);
    await linkEvents(db, version.id, members, writer, now);
  }
  return stored;
}

// ---------------------------------------------------------------------------------------------
// Earthquake clusters

/** Same order as latestVersion(): fetched_at, then source_updated_at (nulls oldest), then id. */
function isNewer(a: EventRecord, b: EventRecord): boolean {
  if (a.fetchedAt !== b.fetchedAt) return a.fetchedAt > b.fetchedAt;
  const ua = a.sourceUpdatedAt ?? -Infinity;
  const ub = b.sourceUpdatedAt ?? -Infinity;
  if (ua !== ub) return ua > ub;
  return a.id > b.id;
}

/**
 * The newest version of every earthquake record with any version in [since, now], left out when
 * that newest version ends the record (meta.deleted) or its origin time falls outside the range.
 */
export async function liveEarthquakes(db: Db, since: number, now: number): Promise<EventRecord[]> {
  // Every version of those records, found through idx_events_record_key.
  const rs = await db.execute({
    sql: `SELECT * FROM events WHERE record_key IN (
            SELECT record_key FROM events WHERE kind = 'earthquake' AND occurred_at >= ? AND occurred_at <= ?)`,
    args: [since, now],
  });
  const newest = new Map<string, EventRecord>();
  for (const row of rs.rows) {
    const e = rowToEvent(row);
    if (e.kind !== "earthquake") continue;
    const prev = newest.get(e.recordKey);
    if (!prev || isNewer(e, prev)) newest.set(e.recordKey, e);
  }
  return [...newest.values()].filter(
    (e) => e.meta?.deleted !== true && e.occurredAt >= since && e.occurredAt <= now,
  );
}

/**
 * Runs the cluster detector over the live quakes of the last 2 * windowHours and stores the
 * clusters anchored in the newest windowHours. The older half is context only: a cluster anchored
 * there may already have lost its own anchor's predecessors to the window edge, and a cluster
 * that swallows a newer one always has its anchor within windowHours before it. Storing only the
 * newer half means a cluster that ages out never comes back as a smaller "new" detection.
 */
export async function runQuakeClusterDetector(db: Db, now: number): Promise<DetectorRun> {
  const windowMs = config.detectors.quakeCluster.windowHours * MS_PER_HOUR;
  const quakes = await liveEarthquakes(db, now - 2 * windowMs, now);
  const byId = new Map(quakes.map((q) => [q.id, q]));
  const results = detectQuakeClusters(quakes);
  const current = results.filter((r) => {
    const anchor = byId.get(String(r.detection.meta?.anchor));
    return anchor !== undefined && anchor.occurredAt >= now - windowMs;
  });
  const stored = await storeDetections(db, current, "ingest", now);
  const skipped = results.length - current.length;
  return {
    examined: quakes.length,
    found: current.length,
    stored,
    skipped,
    ...(skipped ? { note: `${skipped} clusters anchored before the newest window` } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Circling aircraft

/**
 * The aircraft_track and detection to store for one circling hit. The detector builds both ids
 * from a one-way key of (aircraft, episode start) and the track leaves the aircraft field out,
 * so neither record carries the aircraft digest.
 */
export function circlingRecords(
  hit: CirclingHit,
  fetchedAt: number,
): { track: EventRecord; result: DetectionResult } {
  const first = hit.track[0];
  if (!first) throw new Error("A circling hit has no samples");
  const track = buildAircraftTrack(first.aircraft, hit.track, fetchedAt);
  return { track, result: { ...hit.result, members: [...hit.result.members, track.id] } };
}

/**
 * The circling detector's sample buffer after a new round of samples. Every aircraft seen within
 * the last `recentMs` keeps its whole continuous track (no gap over maxGapSeconds), up to
 * maxEpisodeMinutes back; everything else drops out. A plain recentMs window would cut an orbit
 * longer than it, give its remainder a new episode start, and store it as a second detection.
 */
export function trimCirclingBuffer(
  buffer: FlightSample[],
  now: number,
  recentMs: number,
): FlightSample[] {
  const cfg = config.detectors.circling;
  const gapMs = cfg.maxGapSeconds * MS_PER_SECOND;
  const oldest = now - cfg.maxEpisodeMinutes * MS_PER_MINUTE;
  const byAircraft = new Map<string, FlightSample[]>();
  for (const s of buffer) {
    if (s.t < oldest || s.t > now) continue;
    const list = byAircraft.get(s.aircraft);
    if (list) list.push(s);
    else byAircraft.set(s.aircraft, [s]);
  }
  const kept: FlightSample[] = [];
  for (const list of byAircraft.values()) {
    list.sort((a, b) => a.t - b.t);
    const last = list[list.length - 1];
    if (!last || last.t < now - recentMs) continue;
    let first = list.length - 1;
    while (first > 0 && (list[first]?.t ?? 0) - (list[first - 1]?.t ?? 0) <= gapMs) first--;
    kept.push(...list.slice(first));
  }
  return kept;
}

/** Inserts a track version unless stored, pointing it at the newest stored version of its record. */
async function storeTrack(db: Db, track: EventRecord, now: number): Promise<number> {
  if (await exists(db, track.id)) return 0;
  const prev = await latestVersion(db, track.recordKey);
  return insertEvents(db, [{ ...track, supersedes: prev?.id ?? null }], "ingest", now);
}

/**
 * Runs the circling detector over the detector area's recent samples. For each hit, stores the
 * cited aircraft_track first, then the detection with the track as a member.
 */
export async function runCirclingDetector(
  db: Db,
  samples: FlightSample[],
  now: number,
): Promise<DetectorRun> {
  const hits = detectCircling(samples, config.sources.flights.detectorArea.name);
  let stored = 0;
  let tracks = 0;
  for (const hit of hits) {
    const { track, result } = circlingRecords(hit, now);
    tracks += await storeTrack(db, track, now);
    stored += await storeDetections(db, [result], "ingest", now);
  }
  return {
    examined: samples.length,
    found: hits.length,
    stored,
    skipped: 0,
    ...(tracks ? { note: `${tracks} new tracks` } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Fire growth

/**
 * Runs the fire-growth detector over every ready day pair (firms.ts fireGrowthDue: complete days,
 * every batch still stored, persistence judged per sub-cell) and stores what it finds.
 */
export async function runFireGrowthDetector(db: Db, now: number): Promise<DetectorRun> {
  const run = await fireGrowthDue(db, now);
  const stored = await storeDetections(db, run.results, "ingest", now);
  const notes: string[] = [];
  if (run.waiting) notes.push(`${run.waiting} pairs waiting for persistence history`);
  if (run.mismatched) notes.push(`${run.mismatched} findings whose evidence did not match`);
  return {
    examined: run.scored,
    found: run.results.length + run.mismatched,
    stored,
    skipped: run.mismatched,
    ...(notes.length ? { note: notes.join(", ") } : {}),
  };
}
