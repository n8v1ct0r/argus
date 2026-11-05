// Core event-store operations shared by ingest, detectors, the brief, Ask, and the API.
// Every write path goes through chargeWrites() so the Turso Free write guard holds.
import type { InValue, Row } from "@libsql/client";
import { config } from "../../argus.config.ts";
import type { EventRecord, Kind, Source } from "../events/types.ts";
import type { Db } from "./client.ts";

export class WriteBudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteBudgetExceeded";
  }
}

export type Writer = "ingest" | "ask" | "system";

function utcDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Reserves billed writes for today. Throws before writing when the day's guard would be
 * exceeded; Ask has its own smaller budget inside the total and stops first.
 */
export async function chargeWrites(
  db: Db,
  rows: number,
  writer: Writer,
  now = Date.now(),
): Promise<void> {
  if (rows <= 0) return;
  const billed = rows * config.writeGuard.indexFactor;
  const day = utcDayOf(now);
  const rs = await db.execute({
    sql: "SELECT billed_writes, ask_writes FROM write_budget WHERE day = ?",
    args: [day],
  });
  const row = rs.rows[0];
  const used = Number(row?.billed_writes ?? 0);
  const askUsed = Number(row?.ask_writes ?? 0);
  if (writer === "ask" && askUsed + billed > config.writeGuard.askWritesPerDay) {
    throw new WriteBudgetExceeded(`Ask write budget for ${day} is used up`);
  }
  if (used + billed > config.writeGuard.billedWritesPerDay) {
    throw new WriteBudgetExceeded(`Daily write budget for ${day} is used up`);
  }
  await db.execute({
    sql: `INSERT INTO write_budget (day, billed_writes, ask_writes) VALUES (?, ?, ?)
          ON CONFLICT(day) DO UPDATE SET billed_writes = billed_writes + excluded.billed_writes,
                                         ask_writes = ask_writes + excluded.ask_writes`,
    args: [day, billed, writer === "ask" ? billed : 0],
  });
}

const EVENT_COLUMNS =
  "id, record_key, source, kind, occurred_at, fetched_at, source_updated_at, lat, lon, min_lat, min_lon, max_lat, max_lon, title, facts, meta, raw, raw_gz, raw_digest, fetch_id, supersedes";

function eventArgs(e: EventRecord): InValue[] {
  return [
    e.id,
    e.recordKey,
    e.source,
    e.kind,
    e.occurredAt,
    e.fetchedAt,
    e.sourceUpdatedAt,
    e.lat,
    e.lon,
    e.bbox?.minLat ?? null,
    e.bbox?.minLon ?? null,
    e.bbox?.maxLat ?? null,
    e.bbox?.maxLon ?? null,
    e.title,
    JSON.stringify(e.facts),
    e.meta ? JSON.stringify(e.meta) : null,
    e.raw,
    e.rawGz,
    e.rawDigest,
    e.fetchId,
    e.supersedes,
  ];
}

function num(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

export function rowToEvent(r: Row): EventRecord {
  const minLat = num(r.min_lat);
  const rawGz = r.raw_gz as ArrayBuffer | Uint8Array | null;
  return {
    id: String(r.id),
    recordKey: String(r.record_key),
    source: String(r.source) as EventRecord["source"],
    kind: String(r.kind) as Kind,
    occurredAt: Number(r.occurred_at),
    fetchedAt: Number(r.fetched_at),
    sourceUpdatedAt: num(r.source_updated_at),
    lat: num(r.lat),
    lon: num(r.lon),
    bbox:
      minLat === null
        ? null
        : {
            minLat,
            minLon: Number(r.min_lon),
            maxLat: Number(r.max_lat),
            maxLon: Number(r.max_lon),
          },
    title: String(r.title),
    facts: JSON.parse(String(r.facts)),
    meta: r.meta === null ? null : JSON.parse(String(r.meta)),
    raw: r.raw === null ? null : String(r.raw),
    rawGz: rawGz === null ? null : rawGz instanceof Uint8Array ? rawGz : new Uint8Array(rawGz),
    rawDigest: String(r.raw_digest),
    fetchId: r.fetch_id === null ? null : String(r.fetch_id),
    supersedes: r.supersedes === null ? null : String(r.supersedes),
  };
}

/**
 * Inserts event versions. Versions are immutable: an id that already exists is ignored, which
 * makes re-ingesting the same upstream data idempotent. Returns how many rows were new.
 */
export async function insertEvents(
  db: Db,
  events: EventRecord[],
  writer: Writer = "ingest",
  now = Date.now(),
): Promise<number> {
  if (!events.length) return 0;
  const existing = new Set<string>();
  for (let i = 0; i < events.length; i += 400) {
    const chunk = events.slice(i, i + 400);
    const rs = await db.execute({
      sql: `SELECT id FROM events WHERE id IN (${chunk.map(() => "?").join(",")})`,
      args: chunk.map((e) => e.id),
    });
    for (const r of rs.rows) existing.add(String(r.id));
  }
  const fresh = events.filter((e) => !existing.has(e.id));
  if (!fresh.length) return 0;
  await chargeWrites(db, fresh.length, writer, now);
  await db.batch(
    fresh.map((e) => ({
      sql: `INSERT OR IGNORE INTO events (${EVENT_COLUMNS}) VALUES (${EVENT_COLUMNS.split(",")
        .map(() => "?")
        .join(",")})`,
      args: eventArgs(e),
    })),
    "write",
  );
  return fresh.length;
}

export async function getEvents(db: Db, ids: string[]): Promise<EventRecord[]> {
  if (!ids.length) return [];
  const out: EventRecord[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rs = await db.execute({
      sql: `SELECT ${EVENT_COLUMNS} FROM events WHERE id IN (${chunk.map(() => "?").join(",")})`,
      args: chunk,
    });
    out.push(...rs.rows.map(rowToEvent));
  }
  const order = new Map(ids.map((id, i) => [id, i]));
  return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export interface ListQuery {
  kinds: Kind[];
  from?: number;
  to?: number;
  bbox?: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  limit?: number;
  order?: "asc" | "desc";
  /** Leave out raw and raw_gz (list views do not need them). */
  withoutRaw?: boolean;
}

/** Events by kind and time range; uses idx_events_kind_time. */
export async function listEvents(db: Db, q: ListQuery): Promise<EventRecord[]> {
  const where: string[] = [`kind IN (${q.kinds.map(() => "?").join(",")})`];
  const args: InValue[] = [...q.kinds];
  if (q.from !== undefined) {
    where.push("occurred_at >= ?");
    args.push(q.from);
  }
  if (q.to !== undefined) {
    where.push("occurred_at <= ?");
    args.push(q.to);
  }
  if (q.bbox) {
    where.push("lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?");
    args.push(q.bbox.minLat, q.bbox.maxLat, q.bbox.minLon, q.bbox.maxLon);
  }
  const cols = q.withoutRaw
    ? EVENT_COLUMNS.replace("raw, raw_gz", "NULL AS raw, NULL AS raw_gz")
    : EVENT_COLUMNS;
  const rs = await db.execute({
    sql: `SELECT ${cols} FROM events WHERE ${where.join(" AND ")} ORDER BY occurred_at ${
      q.order === "asc" ? "ASC" : "DESC"
    } LIMIT ?`,
    args: [...args, q.limit ?? 1000],
  });
  return rs.rows.map(rowToEvent);
}

/** The newest stored version of an upstream record. */
export async function latestVersion(db: Db, recordKey: string): Promise<EventRecord | null> {
  const rs = await db.execute({
    sql: `SELECT ${EVENT_COLUMNS} FROM events WHERE record_key = ? ORDER BY fetched_at DESC, source_updated_at DESC LIMIT 1`,
    args: [recordKey],
  });
  return rs.rows[0] ? rowToEvent(rs.rows[0]) : null;
}

export async function linkEvents(
  db: Db,
  parentId: string,
  childIds: string[],
  writer: Writer = "ingest",
  now = Date.now(),
): Promise<void> {
  const capped = [...new Set(childIds)].slice(0, 500);
  if (!capped.length) return;
  await chargeWrites(db, capped.length, writer, now);
  await db.batch(
    capped.map((c) => ({
      sql: "INSERT OR IGNORE INTO event_links (parent_id, child_id) VALUES (?, ?)",
      args: [parentId, c],
    })),
    "write",
  );
}

export async function getLinks(db: Db, parentId: string): Promise<string[]> {
  const rs = await db.execute({
    sql: "SELECT child_id FROM event_links WHERE parent_id = ?",
    args: [parentId],
  });
  return rs.rows.map((r) => String(r.child_id));
}

// Fetch log: one row per source per hour, plus one row per error.

export async function logFetch(
  db: Db,
  source: string,
  status: number,
  bytes: number,
  now = Date.now(),
): Promise<void> {
  const hourStart = Math.floor(now / 3_600_000) * 3_600_000;
  const ok = status >= 200 && status < 300;
  await db.execute({
    sql: `INSERT INTO fetch_log (source, hour_start, requests, bytes, last_status, last_ok_at)
          VALUES (?, ?, 1, ?, ?, ?)
          ON CONFLICT(source, hour_start) DO UPDATE SET requests = requests + 1, bytes = bytes + excluded.bytes,
            last_status = excluded.last_status, last_ok_at = COALESCE(excluded.last_ok_at, last_ok_at)`,
    args: [source, hourStart, bytes, status, ok ? now : null],
  });
}

export async function logFetchError(
  db: Db,
  source: string,
  url: string,
  status: number | null,
  message: string,
  now = Date.now(),
): Promise<void> {
  await db.execute({
    sql: "INSERT INTO fetch_errors (source, at, url, status, message) VALUES (?, ?, ?, ?, ?)",
    args: [source, now, url, status, message.slice(0, 500)],
  });
}

/** When each source last fetched successfully (for live, stale, and error states). */
/** The sources that fetch upstream (argus only computes). */
const FETCHING_SOURCES: readonly Source[] = ["usgs", "celestrak", "eonet", "firms", "flights"];

/**
 * Last OK fetch and last status per source that has fetch_log rows. One lookup per source on the
 * primary key's source prefix, because /api/status runs this on every request.
 */
export async function sourceHealth(
  db: Db,
): Promise<Record<string, { lastOkAt: number | null; lastStatus: number | null }>> {
  const results = await db.batch(
    FETCHING_SOURCES.map((source) => ({
      sql: `SELECT COUNT(*) AS n, MAX(last_ok_at) AS last_ok_at,
              (SELECT last_status FROM fetch_log WHERE source = ? ORDER BY hour_start DESC LIMIT 1)
                AS last_status
            FROM fetch_log WHERE source = ?`,
      args: [source, source],
    })),
    "read",
  );
  const out: Record<string, { lastOkAt: number | null; lastStatus: number | null }> = {};
  FETCHING_SOURCES.forEach((source, i) => {
    const r = results[i]?.rows[0];
    if (!r || !Number(r.n)) return;
    out[source] = { lastOkAt: num(r.last_ok_at), lastStatus: num(r.last_status) };
  });
  return out;
}

// Backoff that survives restarts.

export interface BackoffState {
  failures: number;
  nextAllowedAt: number;
  lastStatus: number | null;
}

export async function getBackoff(db: Db, source: string): Promise<BackoffState | null> {
  const rs = await db.execute({
    sql: "SELECT failures, next_allowed_at, last_status FROM backoff WHERE source = ?",
    args: [source],
  });
  const r = rs.rows[0];
  return r
    ? {
        failures: Number(r.failures),
        nextAllowedAt: Number(r.next_allowed_at),
        lastStatus: num(r.last_status),
      }
    : null;
}

/** Exponential backoff from baseMs, capped at maxMs. */
export async function recordFailure(
  db: Db,
  source: string,
  status: number | null,
  baseMs: number,
  maxMs: number,
  now = Date.now(),
): Promise<BackoffState> {
  const prev = await getBackoff(db, source);
  const failures = (prev?.failures ?? 0) + 1;
  const nextAllowedAt = now + Math.min(maxMs, baseMs * 2 ** (failures - 1));
  await db.execute({
    sql: `INSERT INTO backoff (source, failures, next_allowed_at, last_status, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(source) DO UPDATE SET failures = excluded.failures, next_allowed_at = excluded.next_allowed_at,
            last_status = excluded.last_status, updated_at = excluded.updated_at`,
    args: [source, failures, nextAllowedAt, status, now],
  });
  return { failures, nextAllowedAt, lastStatus: status };
}

export async function recordSuccess(db: Db, source: string): Promise<void> {
  await db.execute({ sql: "DELETE FROM backoff WHERE source = ?", args: [source] });
}

// Single-flight lease for the ingest worker.

export async function acquireLease(
  db: Db,
  name: string,
  holder: string,
  ttlMs: number,
  now = Date.now(),
): Promise<boolean> {
  await db.execute({
    sql: `INSERT INTO worker_lease (name, holder, expires_at) VALUES (?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
          WHERE worker_lease.expires_at < ? OR worker_lease.holder = excluded.holder`,
    args: [name, holder, now + ttlMs, now],
  });
  const rs = await db.execute({
    sql: "SELECT holder FROM worker_lease WHERE name = ?",
    args: [name],
  });
  return String(rs.rows[0]?.holder) === holder;
}

export async function releaseLease(db: Db, name: string, holder: string): Promise<void> {
  await db.execute({
    sql: "DELETE FROM worker_lease WHERE name = ? AND holder = ?",
    args: [name, holder],
  });
}
