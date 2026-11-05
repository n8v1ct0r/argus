// Retention (docs/plan.md section 2). Events and briefs are kept for config.retention.hours, fire
// presence for firePresenceDays, the model cache and rate limits for 48 h, and the fetch log for
// 7 days. An event version is old when both its occurrence and its fetch are older than the
// cutoff, so a record fetched today about an older event (EONET lists 3 days) is not deleted and
// fetched again every half hour. Old versions that are never deleted:
//   (a) any version a kept brief cites, or a kept detection links to;
//   (b) fire_batch versions of the newest config.retention.fireDates acquisition dates;
//   (c) the newest version of every satellite_elements record;
// and every newer version of a record with a kept version, so deleting cannot turn an ended
// record (a USGS tombstone) back into a live one. Every delete is charged to the write guard as
// writer "system" before it runs.
import { config } from "../../argus.config.ts";
import type { Db } from "../db/client.ts";
import { chargeWrites } from "../db/queries.ts";
import type { Kind } from "../events/types.ts";
import { MS_PER_DAY, MS_PER_HOUR } from "../lib/time.ts";

export const MODEL_CACHE_MAX_AGE_MS = 48 * MS_PER_HOUR;
export const RATE_LIMIT_MAX_AGE_MS = 48 * MS_PER_HOUR;
export const FETCH_LOG_MAX_AGE_MS = 7 * MS_PER_DAY;

/** Ids per IN (...) list, well under SQLite's variable limit. */
const CHUNK = 400;

// Every kind, checked by the compiler: a new Kind that is missing here fails the typecheck.
const KIND_SET: Record<Kind, true> = {
  earthquake: true,
  satellite_elements: true,
  natural_event: true,
  fire_batch: true,
  fire_cell_day: true,
  flight_frame: true,
  aircraft_track: true,
  detection: true,
  aggregate: true,
};
const ALL_KINDS = Object.keys(KIND_SET) as Kind[];

export interface RetentionSummary {
  /** Event versions deleted. */
  events: number;
  /** Old event versions kept because a rule protects them. */
  keptOld: number;
  briefs: number;
  firePresence: number;
  modelCache: number;
  rateLimits: number;
  fetchLog: number;
  fetchErrors: number;
  /** event_links rows whose parent or child no longer exists. */
  links: number;
}

interface Candidate {
  id: string;
  recordKey: string;
  kind: string;
  occurredAt: number;
  fetchedAt: number;
  sourceUpdatedAt: number | null;
}

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
}

const marks = (n: number) => Array<string>(n).fill("?").join(",");

async function oldVersions(db: Db, cutoff: number): Promise<Candidate[]> {
  const rs = await db.execute({
    sql: `SELECT id, record_key, kind, occurred_at, fetched_at, source_updated_at FROM events
          WHERE kind IN (${marks(ALL_KINDS.length)}) AND occurred_at < ? AND fetched_at < ?`,
    args: [...ALL_KINDS, cutoff, cutoff],
  });
  return rs.rows.map((r) => ({
    id: String(r.id),
    recordKey: String(r.record_key),
    kind: String(r.kind),
    occurredAt: Number(r.occurred_at),
    fetchedAt: Number(r.fetched_at),
    sourceUpdatedAt: r.source_updated_at === null ? null : Number(r.source_updated_at),
  }));
}

/** Every string inside an `event_ids` array, at any depth of a bullets JSON value. */
function collectEventIds(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectEventIds(v, out);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, v] of Object.entries(value)) {
    if (key === "event_ids" && Array.isArray(v)) {
      for (const id of v) if (typeof id === "string") out.add(id);
    } else {
      collectEventIds(v, out);
    }
  }
}

/** Ids cited by briefs that stay (created at or after the cutoff). */
async function citedByKeptBriefs(db: Db, cutoff: number): Promise<Set<string>> {
  const rs = await db.execute({
    sql: "SELECT id, bullets FROM briefs WHERE created_at >= ?",
    args: [cutoff],
  });
  const ids = new Set<string>();
  for (const r of rs.rows) {
    let bullets: unknown;
    try {
      bullets = JSON.parse(String(r.bullets));
    } catch {
      // Without its citations no version can be deleted safely.
      throw new Error(
        `Brief ${String(r.id)} has bullets that are not JSON, so its citations are unknown. ` +
          "Retention deleted no events; fix or delete that brief.",
      );
    }
    collectEventIds(bullets, ids);
  }
  return ids;
}

async function newestFireDates(db: Db): Promise<Set<number>> {
  const rs = await db.execute({
    sql: `SELECT DISTINCT occurred_at FROM events WHERE kind = 'fire_batch'
          ORDER BY occurred_at DESC LIMIT ?`,
    args: [config.retention.fireDates],
  });
  return new Set(rs.rows.map((r) => Number(r.occurred_at)));
}

/** The newest version id of every satellite, in latestVersion() order. */
async function newestSatelliteVersions(db: Db): Promise<Set<string>> {
  const rs = await db.execute(
    `SELECT id FROM (
       SELECT id, ROW_NUMBER() OVER (
         PARTITION BY record_key ORDER BY fetched_at DESC, source_updated_at DESC, id DESC) AS rn
       FROM events WHERE kind = 'satellite_elements')
     WHERE rn = 1`,
  );
  return new Set(rs.rows.map((r) => String(r.id)));
}

/** Children of existing parents that are not being deleted. */
async function linkedFromKeptParents(
  db: Db,
  childIds: string[],
  doomed: Set<string>,
): Promise<Set<string>> {
  const kept = new Set<string>();
  for (const chunk of chunks(childIds)) {
    const rs = await db.execute({
      sql: `SELECT l.parent_id, l.child_id FROM event_links l JOIN events p ON p.id = l.parent_id
            WHERE l.child_id IN (${marks(chunk.length)})`,
      args: chunk,
    });
    for (const r of rs.rows) {
      if (!doomed.has(String(r.parent_id))) kept.add(String(r.child_id));
    }
  }
  return kept;
}

/** Same order as latestVersion(): fetched_at, then source_updated_at (nulls oldest), then id. */
function byVersionAge(a: Candidate, b: Candidate): number {
  if (a.fetchedAt !== b.fetchedAt) return a.fetchedAt - b.fetchedAt;
  const ua = a.sourceUpdatedAt ?? -Infinity;
  const ub = b.sourceUpdatedAt ?? -Infinity;
  if (ua !== ub) return ua < ub ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Keeps every candidate newer than a kept candidate of the same record. */
function keepNewerVersions(candidates: Candidate[], keep: Set<string>): void {
  const byRecord = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = byRecord.get(c.recordKey);
    if (list) list.push(c);
    else byRecord.set(c.recordKey, [c]);
  }
  for (const list of byRecord.values()) {
    if (list.length < 2) continue;
    let keeping = false;
    for (const c of list.sort(byVersionAge)) {
      if (keeping) keep.add(c.id);
      else if (keep.has(c.id)) keeping = true;
    }
  }
}

async function pruneEvents(
  db: Db,
  cutoff: number,
  now: number,
): Promise<{ deleted: number; keptOld: number }> {
  const candidates = await oldVersions(db, cutoff);
  if (!candidates.length) return { deleted: 0, keptOld: 0 };

  const keep = await citedByKeptBriefs(db, cutoff);
  const fireDates = await newestFireDates(db);
  const newestSatellites = await newestSatelliteVersions(db);
  for (const c of candidates) {
    if (c.kind === "fire_batch" && fireDates.has(c.occurredAt)) keep.add(c.id);
    if (c.kind === "satellite_elements" && newestSatellites.has(c.id)) keep.add(c.id);
  }
  keepNewerVersions(candidates, keep);

  // Detections are the only parents; the ones not kept by now are deleted with their links.
  const doomed = new Set(candidates.filter((c) => !keep.has(c.id)).map((c) => c.id));
  const linked = await linkedFromKeptParents(
    db,
    candidates.map((c) => c.id),
    doomed,
  );
  for (const id of linked) keep.add(id);
  keepNewerVersions(candidates, keep);

  const ids = candidates.filter((c) => !keep.has(c.id)).map((c) => c.id);
  if (ids.length) {
    await chargeWrites(db, ids.length, "system", now);
    await db.batch(
      chunks(ids).map((chunk) => ({
        sql: `DELETE FROM events WHERE id IN (${marks(chunk.length)})`,
        args: chunk,
      })),
      "write",
    );
  }
  return { deleted: ids.length, keptOld: candidates.length - ids.length };
}

/** Counts, charges, then deletes the rows of one table that match `where`. */
async function pruneRows(
  db: Db,
  table: string,
  where: string,
  args: number[],
  now: number,
): Promise<number> {
  const rs = await db.execute({ sql: `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, args });
  const n = Number(rs.rows[0]?.n ?? 0);
  if (!n) return 0;
  await chargeWrites(db, n, "system", now);
  await db.execute({ sql: `DELETE FROM ${table} WHERE ${where}`, args });
  return n;
}

/** One retention pass at `now` (epoch ms, like every time column in the schema). */
export async function applyRetention(db: Db, now: number): Promise<RetentionSummary> {
  const cutoff = now - config.retention.hours * MS_PER_HOUR;
  const { deleted, keptOld } = await pruneEvents(db, cutoff, now);
  const oldestPresenceDay = Math.floor(now / MS_PER_DAY) - config.retention.firePresenceDays;
  const fetchCutoff = now - FETCH_LOG_MAX_AGE_MS;
  return {
    events: deleted,
    keptOld,
    briefs: await pruneRows(db, "briefs", "created_at < ?", [cutoff], now),
    firePresence: await pruneRows(db, "fire_presence", "day_key < ?", [oldestPresenceDay], now),
    modelCache: await pruneRows(
      db,
      "model_cache",
      "created_at < ?",
      [now - MODEL_CACHE_MAX_AGE_MS],
      now,
    ),
    rateLimits: await pruneRows(
      db,
      "rate_limits",
      "window_start < ?",
      [now - RATE_LIMIT_MAX_AGE_MS],
      now,
    ),
    fetchLog: await pruneRows(db, "fetch_log", "hour_start < ?", [fetchCutoff], now),
    fetchErrors: await pruneRows(db, "fetch_errors", "at < ?", [fetchCutoff], now),
    links: await pruneRows(
      db,
      "event_links",
      `NOT EXISTS (SELECT 1 FROM events e WHERE e.id = event_links.parent_id)
       OR NOT EXISTS (SELECT 1 FROM events e WHERE e.id = event_links.child_id)`,
      [],
      now,
    ),
  };
}
