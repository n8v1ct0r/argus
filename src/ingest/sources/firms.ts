// NASA FIRMS adapter: the keyless global VIIRS 24 h files for NOAA-20 and NOAA-21
// (docs/plan.md sections 1d and 3c).
//
// Ingest: an hourly HEAD per satellite; a GET only when Last-Modified changed (the server ignores
// conditional GETs). Each GET writes a new immutable version of every (satellite, acquisition
// date) batch whose CSV changed, because FIRMS removes anomalous detections after publishing.
//
// If a "24 h" file is a rolling window, the older date in it loses its early detections as the
// window moves, and a latest-version-wins store would shrink that date every hour. So a new batch
// version carries forward the previous version's lines that are older than the new file's
// earliest acquisition time: inside the file's span the file is the truth (removals are honored),
// before it the last stored lines are. (Measured once: at 01:40 UTC on 2026-09-24 the NOAA-20 file
// held 2026-09-22 00:13 to 2026-09-23 23:14 UTC, two whole dates, where carrying is a no-op.)
//
// Fire presence: per (local solar day, satellite), the count of detections whose confidence is in
// config.detectors.fireGrowth.fireConfidence, per persistence sub-cell (1/50 degree). The
// persistence mask judges sub-cells; the fire-growth detector sums the unmasked sub-cells of each
// 1 degree cell. fireGrowthDue runs the whole detector for the worker.
import { config } from "../../../argus.config.ts";
import type { Db } from "../../db/client.ts";
import { chargeWrites, getEvents, insertEvents, latestVersion } from "../../db/queries.ts";
import { buildFireGrowthDetection, detectFireGrowth } from "../../detectors/fire-growth.ts";
import { persistentCells } from "../../detectors/fire-mask.ts";
import type { DetectionResult, FireDayCounts } from "../../detectors/types.ts";
import { count, label } from "../../events/facts.ts";
import type { BBox, EventRecord } from "../../events/types.ts";
import { sha256Hex } from "../../lib/digest.ts";
import { gunzipText, gzipText } from "../../lib/gzip.ts";
import { recordKeyOf, versionId } from "../../lib/ids.ts";
import {
  dayKeyLabel,
  localSolarDayKey,
  MS_PER_DAY,
  MS_PER_HOUR,
  solarDayStartMs,
  utcDay,
} from "../../lib/time.ts";
import { sourceFetch } from "../http.ts";
import type { RunDeps, SourceRunResult } from "../types.ts";

export type FirmsSatellite = (typeof config.detectors.fireGrowth.satellites)[number];
export type FireConfidence = "low" | "nominal" | "high";

/** One detection from a FIRMS CSV. Only the fields Argus computes with are parsed. */
export interface FirmsRow {
  /** The header line of the file this row came from (shared by every row of one parse). */
  header: string;
  /** The CSV line exactly as received, without its line ending. */
  line: string;
  lat: number;
  lon: number;
  /** acq_date as written: "YYYY-MM-DD" (UTC). */
  acqDate: string;
  /** acq_time as "HHMM" (UTC), zero-padded when the file drops leading zeros. */
  acqTime: string;
  /** Acquisition time in ms since the epoch. */
  acqMs: number;
  /** Normalized from the file words (low, nominal, high) or the API letters (l, n, h). */
  confidence: FireConfidence;
}

const SOURCE = "firms";
const SATELLITES: readonly FirmsSatellite[] = config.detectors.fireGrowth.satellites;
const SATELLITE_NAMES: Record<FirmsSatellite, string> = { N20: "NOAA-20", N21: "NOAA-21" };
// The one contact User-Agent the plan approved (decision 4). It lives under flights in the config.
const USER_AGENT = config.userAgent;
const CELL_DEG = config.detectors.fireGrowth.cellDeg;
// Persistence sub-cells: SUB_PER_DEG per degree, packed row-major from (-90, -180) into one integer.
const SUB_PER_DEG = config.detectors.fireGrowth.persistenceSubcellsPerDeg;
const SUB_PER_CELL = SUB_PER_DEG * CELL_DEG;
if (!Number.isInteger(SUB_PER_DEG) || !Number.isInteger(SUB_PER_CELL)) {
  throw new Error("persistenceSubcellsPerDeg times cellDeg must be a whole number");
}
const SUB_COLS = 360 * SUB_PER_DEG;
const SUB_ROW0 = 90 * SUB_PER_DEG;
const SUB_COL0 = 180 * SUB_PER_DEG;
const COUNTED: ReadonlySet<string> = new Set<string>(config.detectors.fireGrowth.fireConfidence);
// The 7-day files are about 43 MB each.
const BULK_TIMEOUT_MS = 10 * 60_000;

const CONFIDENCE: Record<string, FireConfidence> = {
  low: "low",
  l: "low",
  nominal: "nominal",
  n: "nominal",
  high: "high",
  h: "high",
};

// ---------------------------------------------------------------------------------------------
// Parsing

/**
 * Parses a FIRMS VIIRS CSV. Columns are found by name, never by position. Throws on a missing
 * column, a line whose field count differs from the header (a truncated download), or a value
 * that does not parse, so a damaged file never becomes a batch version that looks like removals.
 */
export function parseFirmsCsv(text: string): FirmsRow[] {
  const lines = text.replace(/^\uFEFF/, "").split("\n");
  let i = 0;
  while (i < lines.length && stripCr(lines[i] ?? "").trim() === "") i++;
  const header = stripCr(lines[i] ?? "");
  if (!header.trim()) return [];
  const names = header.split(",").map((n) => n.trim().toLowerCase());
  const col = (name: string): number => {
    const idx = names.indexOf(name);
    if (idx < 0) throw new Error(`FIRMS CSV has no "${name}" column`);
    return idx;
  };
  const iLat = col("latitude");
  const iLon = col("longitude");
  const iDate = col("acq_date");
  const iTime = col("acq_time");
  const iConf = col("confidence");

  const rows: FirmsRow[] = [];
  for (i += 1; i < lines.length; i++) {
    const line = stripCr(lines[i] ?? "");
    if (line.trim() === "") continue;
    const at = `FIRMS CSV line ${i + 1}`;
    const fields = line.split(",");
    if (fields.length !== names.length) {
      throw new Error(`${at}: ${fields.length} fields, header has ${names.length}`);
    }
    const lat = Number(fields[iLat]);
    const lon = Number(fields[iLon]);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error(`${at}: bad latitude`);
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error(`${at}: bad longitude`);
    const acqDate = (fields[iDate] ?? "").trim();
    const acqTime = (fields[iTime] ?? "").trim().padStart(4, "0");
    const acqMs = acquisitionMs(acqDate, acqTime);
    if (acqMs === null) throw new Error(`${at}: bad acq_date or acq_time`);
    const confidence = CONFIDENCE[(fields[iConf] ?? "").trim().toLowerCase()];
    if (!confidence) throw new Error(`${at}: unknown confidence "${fields[iConf] ?? ""}"`);
    rows.push({ header, line, lat, lon, acqDate, acqTime, acqMs, confidence });
  }
  return rows;
}

function stripCr(s: string): string {
  return s.endsWith("\r") ? s.slice(0, -1) : s;
}

function acquisitionMs(date: string, time: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2})(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const [y, mo, da, hh, mm] = [d[1], d[2], d[3], t[1], t[2]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (hh > 23 || mm > 59) return null;
  const ms = Date.UTC(y, mo - 1, da, hh, mm);
  return utcDay(ms) === date ? ms : null;
}

// ---------------------------------------------------------------------------------------------
// Cells and local solar days

/** The persistence sub-cell of a point: one integer, row-major from (-90, -180). */
export function subcellOf(lat: number, lon: number): number {
  const row = Math.floor(lat * SUB_PER_DEG) + SUB_ROW0;
  // Longitude 180 joins the last column instead of wrapping into the next row.
  const col = Math.min(Math.floor(lon * SUB_PER_DEG) + SUB_COL0, SUB_COLS - 1);
  return row * SUB_COLS + col;
}

/** The cell key of a sub-cell, by integer division, so every sub-cell has exactly one cell. */
export function cellOfSubcell(subcell: number): string {
  const row = Math.floor(subcell / SUB_COLS) - SUB_ROW0;
  const col = (subcell % SUB_COLS) - SUB_COL0;
  return `${Math.floor(row / SUB_PER_CELL) * CELL_DEG},${Math.floor(col / SUB_PER_CELL) * CELL_DEG}`;
}

/** Cell key "floor(lat),floor(lon)" at config cellDeg (1 degree), through the sub-cell grid. */
export function cellKeyOf(lat: number, lon: number): string {
  return cellOfSubcell(subcellOf(lat, lon));
}

/** The center of a cell, parsed from its key. */
export function cellCenter(cellKey: string): { lat: number; lon: number } {
  const [a, b, extra] = cellKey.split(",");
  const south = Number(a);
  const west = Number(b);
  if (extra !== undefined || a === undefined || b === undefined || a === "" || b === "") {
    throw new Error(`Bad cell key "${cellKey}"`);
  }
  if (!Number.isFinite(south) || !Number.isFinite(west))
    throw new Error(`Bad cell key "${cellKey}"`);
  return { lat: south + CELL_DEG / 2, lon: west + CELL_DEG / 2 };
}

/** Local solar day of a detection, taken at its cell center longitude (docs/plan.md 3c). */
export function rowDayKey(row: FirmsRow): number {
  return localSolarDayKey(row.acqMs, cellCenterLon(subcellOf(row.lat, row.lon)));
}

/** The center longitude of the cell a sub-cell falls in. */
function cellCenterLon(subcell: number): number {
  const col = (subcell % SUB_COLS) - SUB_COL0;
  return Math.floor(col / SUB_PER_CELL) * CELL_DEG + CELL_DEG / 2;
}

/** The calendar date of a local solar day (see dayKeyLabel in src/lib/time.ts). */
export function solarDayLabel(dayKey: number): string {
  return dayKeyLabel(dayKey);
}

/** The UTC dates a cell's local solar day spans (always 2 at 1 degree cells). */
function spannedDates(dayKey: number, lon: number): string[] {
  const start = solarDayStartMs(dayKey, lon);
  return [...new Set([utcDay(start), utcDay(start + MS_PER_DAY - 1)])];
}

// ---------------------------------------------------------------------------------------------
// Batches

function csvText(header: string, lines: string[]): string {
  return `${header}\n${lines.map((l) => `${l}\n`).join("")}`;
}

/** Canonical order: acquisition time, then the line itself, so equal sets hash equal. */
function byTimeThenLine(a: FirmsRow, b: FirmsRow): number {
  return a.acqMs - b.acqMs || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0);
}

function bboxOf(rows: FirmsRow[]): BBox | null {
  if (!rows.length) return null;
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (const r of rows) {
    minLat = Math.min(minLat, r.lat);
    minLon = Math.min(minLon, r.lon);
    maxLat = Math.max(maxLat, r.lat);
    maxLon = Math.max(maxLon, r.lon);
  }
  return { minLat, minLon, maxLat, maxLon };
}

function batchNativeId(satellite: FirmsSatellite, date: string): string {
  return `${satellite}:${date}`;
}

function satelliteName(satellite: string): string {
  const name = SATELLITE_NAMES[satellite as FirmsSatellite];
  if (!name) throw new Error(`Unknown FIRMS satellite "${satellite}"`);
  return name;
}

interface BatchInput {
  header: string;
  date: string;
  rows: FirmsRow[];
  satellite: FirmsSatellite;
  fetchedAt: number;
  fetchId: string;
  lastModified: string | null;
  carriedRows: number;
}

function buildBatch(b: BatchInput): EventRecord {
  const sorted = [...b.rows].sort(byTimeThenLine);
  const csv = csvText(
    b.header,
    sorted.map((r) => r.line),
  );
  const nativeId = batchNativeId(b.satellite, b.date);
  const name = satelliteName(b.satellite);
  const lastModifiedMs = b.lastModified === null ? NaN : Date.parse(b.lastModified);
  return {
    id: versionId(SOURCE, nativeId, b.fetchId),
    recordKey: recordKeyOf(SOURCE, nativeId),
    source: SOURCE,
    kind: "fire_batch",
    // The acquisition date at 00:00 UTC; the batch covers that whole UTC day.
    occurredAt: Date.parse(`${b.date}T00:00:00Z`),
    fetchedAt: b.fetchedAt,
    sourceUpdatedAt: Number.isFinite(lastModifiedMs) ? lastModifiedMs : null,
    lat: null,
    lon: null,
    bbox: bboxOf(sorted),
    title: `${name} fire detections on ${b.date}`,
    facts: {
      count: count(sorted.length),
      date: label(b.date),
      satellite: label(name),
    },
    meta: {
      satellite: b.satellite,
      lastModified: b.lastModified,
      rows: sorted.length,
      // Lines kept from the previous version because they are older than this file's window.
      carriedRows: b.carriedRows,
      // rawDigest is SHA-256 of the uncompressed CSV text, not of the stored gzip bytes.
      digestOf: "csv",
    },
    raw: null,
    rawGz: gzipText(csv),
    rawDigest: sha256Hex(csv),
    fetchId: b.fetchId,
    supersedes: null,
  };
}

function groupByDate(rows: FirmsRow[]): Map<string, FirmsRow[]> {
  const out = new Map<string, FirmsRow[]>();
  for (const r of rows) {
    const list = out.get(r.acqDate);
    if (list) list.push(r);
    else out.set(r.acqDate, [r]);
  }
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function headerOf(rows: FirmsRow[]): string {
  const header = rows[0]?.header ?? "";
  if (rows.some((r) => r.header !== header))
    throw new Error("FIRMS rows come from different headers");
  return header;
}

/**
 * One fire_batch event per acquisition date: raw_gz is the header plus that date's CSV lines
 * (sorted by acquisition time, then line), rawDigest is SHA-256 of that uncompressed CSV text.
 */
export function groupBatches(
  rows: FirmsRow[],
  satellite: FirmsSatellite,
  fetchedAt: number,
  fetchId: string,
  lastModified: string | null,
): EventRecord[] {
  const header = headerOf(rows);
  return [...groupByDate(rows)].map(([date, dateRows]) =>
    buildBatch({
      header,
      date,
      rows: dateRows,
      satellite,
      fetchedAt,
      fetchId,
      lastModified,
      carriedRows: 0,
    }),
  );
}

function batchRows(e: EventRecord): FirmsRow[] {
  if (e.rawGz) return parseFirmsCsv(gunzipText(e.rawGz));
  return e.raw === null ? [] : parseFirmsCsv(e.raw);
}

/** "firms:N20:2026-09-22" to its satellite and date. */
function parseBatchKey(recordKey: string): { satellite: FirmsSatellite; date: string } | null {
  const m = /^firms:([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(recordKey);
  if (!m || !(SATELLITES as readonly string[]).includes(m[1] ?? "")) return null;
  return { satellite: m[1] as FirmsSatellite, date: m[2] ?? "" };
}

/** The latest stored version of every fire batch whose date overlaps [fromMs, toMs]. */
async function latestBatches(db: Db, fromMs?: number, toMs?: number): Promise<EventRecord[]> {
  const where = ["kind = 'fire_batch'"];
  const args: number[] = [];
  if (fromMs !== undefined) {
    where.push("occurred_at > ?");
    args.push(fromMs - MS_PER_DAY);
  }
  if (toMs !== undefined) {
    where.push("occurred_at <= ?");
    args.push(toMs);
  }
  const rs = await db.execute({
    sql: `SELECT id, record_key FROM events WHERE ${where.join(" AND ")}
          ORDER BY fetched_at DESC, source_updated_at DESC`,
    args,
  });
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const r of rs.rows) {
    const key = String(r.record_key);
    if (seen.has(key) || !parseBatchKey(key)) continue;
    seen.add(key);
    ids.push(String(r.id));
  }
  return getEvents(db, ids);
}

/** Last-Modified stored in the newest fire_batch version of a satellite, if any. */
async function storedLastModified(db: Db, satellite: FirmsSatellite): Promise<string | null> {
  // A range on record_key uses idx_events_record_key (";" sorts right after ":").
  const rs = await db.execute({
    sql: `SELECT meta FROM events WHERE record_key >= ? AND record_key < ? AND kind = 'fire_batch'
          ORDER BY fetched_at DESC LIMIT 1`,
    args: [`firms:${satellite}:`, `firms:${satellite};`],
  });
  const meta = rs.rows[0]?.meta;
  if (meta === null || meta === undefined) return null;
  const value = (JSON.parse(String(meta)) as { lastModified?: unknown }).lastModified;
  return typeof value === "string" ? value : null;
}

// ---------------------------------------------------------------------------------------------
// Ingest

interface SatelliteRun {
  fetched: number;
  inserted: number;
  downloaded: boolean;
}

async function runSatellite(
  db: Db,
  satellite: FirmsSatellite,
  deps: RunDeps,
): Promise<SatelliteRun> {
  const url = config.sources.firms.files[satellite];
  const opts = { headers: { "User-Agent": USER_AGENT }, now: deps.now, fetchImpl: deps.fetchImpl };
  const head = await sourceFetch(db, SOURCE, url, { ...opts, method: "HEAD" });
  if (!head.ok) throw new Error(`HEAD returned HTTP ${head.status}`);
  const headModified = head.headers.get("last-modified");
  if (headModified !== null && headModified === (await storedLastModified(db, satellite))) {
    return { fetched: 0, inserted: 0, downloaded: false };
  }

  const res = await sourceFetch(db, SOURCE, url, { ...opts, method: "GET" });
  if (!res.ok) throw new Error(`GET returned HTTP ${res.status}`);
  const rows = parseFirmsCsv(await res.text());
  const lastModified = res.headers.get("last-modified") ?? headModified;
  if (!rows.length) return { fetched: 0, inserted: 0, downloaded: true };

  const header = headerOf(rows);
  let windowStart = Infinity;
  for (const r of rows) windowStart = Math.min(windowStart, r.acqMs);
  const fetchId = String(deps.now);
  const fresh: EventRecord[] = [];
  for (const [date, dateRows] of groupByDate(rows)) {
    const recordKey = recordKeyOf(SOURCE, batchNativeId(satellite, date));
    const prev = await latestVersion(db, recordKey);
    const carried = prev
      ? batchRows(prev).filter((r) => r.acqMs < windowStart && r.header === header)
      : [];
    const next = buildBatch({
      header,
      date,
      rows: [...carried, ...dateRows],
      satellite,
      fetchedAt: deps.now,
      fetchId,
      lastModified,
      carriedRows: carried.length,
    });
    if (prev && prev.rawDigest === next.rawDigest) continue;
    fresh.push(prev ? { ...next, supersedes: prev.id } : next);
  }
  const inserted = await insertEvents(db, fresh, "ingest", deps.now);
  return { fetched: rows.length, inserted, downloaded: true };
}

/**
 * One FIRMS run: for each satellite, HEAD the 24 h file and GET it only when Last-Modified
 * differs from the one stored with the newest batch. Recomputes fire presence after new versions.
 */
export async function runFirms(db: Db, deps: RunDeps): Promise<SourceRunResult> {
  let fetched = 0;
  let inserted = 0;
  let downloaded = false;
  const errors: string[] = [];
  for (const satellite of SATELLITES) {
    try {
      const r = await runSatellite(db, satellite, deps);
      fetched += r.fetched;
      inserted += r.inserted;
      downloaded ||= r.downloaded;
    } catch (err) {
      errors.push(`${satellite}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (inserted > 0) {
    try {
      await recomputePresence(db, deps.now);
    } catch (err) {
      errors.push(`presence: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (errors.length) {
    return { source: SOURCE, fetched, inserted, status: "error", message: errors.join("; ") };
  }
  return { source: SOURCE, fetched, inserted, status: downloaded ? "ok" : "not_modified" };
}

// ---------------------------------------------------------------------------------------------
// Fire presence

/** Counted detections per persistence sub-cell. */
type SubcellCounts = Map<number, number>;

/** Counted detections per local solar day and sub-cell, plus every day any row fell on. */
function countByDayAndSubcell(rows: FirmsRow[]): {
  counts: Map<number, SubcellCounts>;
  days: Set<number>;
} {
  const counts = new Map<number, SubcellCounts>();
  const days = new Set<number>();
  for (const r of rows) {
    const day = rowDayKey(r);
    days.add(day);
    if (!COUNTED.has(r.confidence)) continue;
    const sub = subcellOf(r.lat, r.lon);
    let subs = counts.get(day);
    if (!subs) counts.set(day, (subs = new Map()));
    subs.set(sub, (subs.get(sub) ?? 0) + 1);
  }
  return { counts, days };
}

/** Sorted sub-cell ids, delta-coded, with their counts: small numbers that gzip well. */
function encodeSubcells(subs: ReadonlyMap<number, number>): string {
  const ids = [...subs.keys()].sort((a, b) => a - b);
  const d: number[] = [];
  const n: number[] = [];
  let prev = 0;
  for (const id of ids) {
    d.push(id - prev);
    n.push(subs.get(id) ?? 0);
    prev = id;
  }
  return JSON.stringify({ d, n });
}

function decodeSubcells(bytes: ArrayBuffer | Uint8Array): SubcellCounts {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const { d, n } = JSON.parse(gunzipText(u8)) as { d: number[]; n: number[] };
  const out: SubcellCounts = new Map();
  let id = 0;
  d.forEach((delta, i) => {
    id += delta;
    out.set(id, n[i] ?? 0);
  });
  return out;
}

async function readPresence(
  db: Db,
  satellite: string,
  fromDay: number,
  toDay: number,
): Promise<Map<number, SubcellCounts>> {
  const rs = await db.execute({
    sql: `SELECT day_key, subcells_gz FROM fire_presence
          WHERE day_key >= ? AND day_key <= ? AND satellite = ?`,
    args: [fromDay, toDay, satellite],
  });
  return new Map(
    rs.rows.map((r) => [
      Number(r.day_key),
      decodeSubcells(r.subcells_gz as ArrayBuffer | Uint8Array),
    ]),
  );
}

export interface PresenceWrite {
  dayKey: number;
  satellite: string;
  /** Counted detections per sub-cell (see subcellOf). */
  subcells: ReadonlyMap<number, number>;
}

/** Upserts fire_presence rows, charged to the write guard. */
export async function storePresence(db: Db, writes: PresenceWrite[], now: number): Promise<void> {
  if (!writes.length) return;
  await chargeWrites(db, writes.length, "ingest", now);
  await db.batch(
    writes.map((w) => ({
      sql: `INSERT INTO fire_presence (day_key, satellite, subcells_gz) VALUES (?, ?, ?)
            ON CONFLICT(day_key, satellite) DO UPDATE SET subcells_gz = excluded.subcells_gz`,
      args: [w.dayKey, w.satellite, gzipText(encodeSubcells(w.subcells))],
    })),
    "write",
  );
}

/**
 * Rebuilds fire_presence from the latest version of every stored batch: counted detections per
 * (local solar day, satellite, sub-cell). A sub-cell day whose first UTC date (at its cell's
 * longitude) is older than a satellite's earliest stored batch (retention pruned it) keeps the
 * larger of its stored and recomputed count, so pruning never shrinks a day that was counted
 * while it was whole. Unchanged rows are not rewritten.
 */
export async function recomputePresence(db: Db, now: number): Promise<void> {
  const bySatellite = new Map<FirmsSatellite, { dates: string[]; rows: FirmsRow[] }>();
  for (const batch of await latestBatches(db)) {
    const key = parseBatchKey(batch.recordKey);
    if (!key) continue;
    let entry = bySatellite.get(key.satellite);
    if (!entry) bySatellite.set(key.satellite, (entry = { dates: [], rows: [] }));
    entry.dates.push(key.date);
    for (const r of batchRows(batch)) entry.rows.push(r);
  }

  const writes: PresenceWrite[] = [];
  for (const [satellite, { dates, rows }] of bySatellite) {
    const earliest = [...dates].sort()[0] ?? "";
    const { counts, days } = countByDayAndSubcell(rows);
    const dayKeys = [...days].sort((a, b) => a - b);
    const first = dayKeys[0];
    const last = dayKeys[dayKeys.length - 1];
    if (first === undefined || last === undefined) continue;
    const stored = await readPresence(db, satellite, first, last);
    const pruned = (sub: number, day: number) =>
      (spannedDates(day, cellCenterLon(sub))[0] ?? "") < earliest;

    for (const day of dayKeys) {
      const fresh = counts.get(day) ?? new Map<number, number>();
      const old = stored.get(day);
      const merged: SubcellCounts = new Map(fresh);
      if (old) {
        for (const [sub, n] of old) {
          if (pruned(sub, day)) merged.set(sub, Math.max(n, fresh.get(sub) ?? 0));
        }
      }
      if (old && encodeSubcells(old) === encodeSubcells(merged)) continue;
      writes.push({ dayKey: day, satellite, subcells: merged });
    }
  }
  await storePresence(db, writes, now);
}

/**
 * Counted detections per cell for one local solar day, summed over the satellites that reported,
 * leaving out every sub-cell in `mask` (persistent heat sources; pass an empty set for none).
 */
export async function loadFireDayCounts(
  db: Db,
  dayKey: number,
  mask: ReadonlySet<number>,
): Promise<FireDayCounts> {
  const rs = await db.execute({
    sql: "SELECT satellite, subcells_gz FROM fire_presence WHERE day_key = ?",
    args: [dayKey],
  });
  const satellites: string[] = [];
  const counts = new Map<string, number>();
  for (const r of rs.rows) {
    satellites.push(String(r.satellite));
    for (const [sub, n] of decodeSubcells(r.subcells_gz as ArrayBuffer | Uint8Array)) {
      if (mask.has(sub)) continue;
      const cell = cellOfSubcell(sub);
      counts.set(cell, (counts.get(cell) ?? 0) + n);
    }
  }
  const order = (s: string) => {
    const i = (SATELLITES as readonly string[]).indexOf(s);
    return i < 0 ? SATELLITES.length : i;
  };
  satellites.sort((a, b) => order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0));
  return { dayKey, satellites, counts };
}

/**
 * The stored presence days before `beforeDayKey` (exclusive), at most `days` back, oldest first.
 * `cells` holds every sub-cell with at least 1 counted detection from any satellite.
 */
export async function presenceHistory(
  db: Db,
  beforeDayKey: number,
  days: number,
): Promise<Array<{ dayKey: number; cells: Set<number> }>> {
  const rs = await db.execute({
    sql: `SELECT day_key, subcells_gz FROM fire_presence WHERE day_key >= ? AND day_key < ?
          ORDER BY day_key`,
    args: [beforeDayKey - days, beforeDayKey],
  });
  const out = new Map<number, Set<number>>();
  for (const r of rs.rows) {
    const day = Number(r.day_key);
    let cells = out.get(day);
    if (!cells) out.set(day, (cells = new Set()));
    for (const [sub, n] of decodeSubcells(r.subcells_gz as ArrayBuffer | Uint8Array)) {
      if (n > 0) cells.add(sub);
    }
  }
  return [...out].map(([dayKey, cells]) => ({ dayKey, cells }));
}

// ---------------------------------------------------------------------------------------------
// Evidence and the layer

/**
 * Stores and returns the evidence for one cell and local solar day: a fire_cell_day event whose
 * raw is the header plus every counted detection line in that cell and day, taken from the latest
 * batch versions, leaving out lines in `mask` sub-cells exactly as loadFireDayCounts does. Its
 * count fact therefore equals the number of lines and the count the detector used.
 * `rowsOf` lets a caller that reads the same batches many times parse each one once.
 */
export async function materializeCellDay(
  db: Db,
  cellKey: string,
  dayKey: number,
  fetchedAt: number,
  mask: ReadonlySet<number>,
  rowsOf: (batch: EventRecord) => FirmsRow[] = batchRows,
): Promise<EventRecord> {
  const center = cellCenter(cellKey);
  const dates = spannedDates(dayKey, center.lon);
  const used: Array<{ satellite: FirmsSatellite; batch: EventRecord }> = [];
  // Batches found per satellite, and the satellites that reported on this day anywhere on Earth
  // (the same rule recomputePresence uses, so this matches loadFireDayCounts).
  const batchesFound = new Map<FirmsSatellite, number>();
  const reported = new Set<FirmsSatellite>();
  const headers = new Set<string>();
  const lines: FirmsRow[] = [];
  let leftOut = 0;
  for (const satellite of SATELLITES) {
    for (const date of dates) {
      const batch = await latestVersion(db, recordKeyOf(SOURCE, batchNativeId(satellite, date)));
      if (!batch) continue;
      used.push({ satellite, batch });
      batchesFound.set(satellite, (batchesFound.get(satellite) ?? 0) + 1);
      const rows = rowsOf(batch);
      if (rows[0]) headers.add(rows[0].header);
      for (const r of rows) {
        if (!reported.has(satellite) && rowDayKey(r) === dayKey) reported.add(satellite);
        if (!COUNTED.has(r.confidence) || cellKeyOf(r.lat, r.lon) !== cellKey) continue;
        if (localSolarDayKey(r.acqMs, center.lon) !== dayKey) continue;
        if (mask.has(subcellOf(r.lat, r.lon))) leftOut += 1;
        else lines.push(r);
      }
    }
  }
  const [header, ...otherHeaders] = headers;
  if (header === undefined || !reported.size) {
    throw new Error(`No stored FIRMS batch reports cell ${cellKey} on day ${dayKey}`);
  }
  if (otherHeaders.length)
    throw new Error("FIRMS batches for this cell day have different headers");
  lines.sort(byTimeThenLine);
  const raw = csvText(
    header,
    lines.map((r) => r.line),
  );
  const rawDigest = sha256Hex(raw);
  // Event ids end at a comma in text (EVENT_ID_PATTERN), so the id spells the cell with "_".
  const nativeId = `cell:${cellKey.split(",").join("_")}:${dayKey}`;
  const id = versionId(SOURCE, nativeId, rawDigest.slice(0, 12));
  const recordKey = recordKeyOf(SOURCE, nativeId);

  const prev = await latestVersion(db, recordKey);
  if (prev?.id === id) return prev;

  const satellites = SATELLITES.filter((s) => reported.has(s));
  const date = solarDayLabel(dayKey);
  const cited = used.filter((u) => reported.has(u.satellite)).map((u) => u.batch);
  const updated = cited.map((b) => b.sourceUpdatedAt).filter((v): v is number => v !== null);
  const start = solarDayStartMs(dayKey, center.lon);
  const half = CELL_DEG / 2;
  const event: EventRecord = {
    id,
    recordKey,
    source: SOURCE,
    kind: "fire_cell_day",
    occurredAt: start,
    fetchedAt,
    sourceUpdatedAt: updated.length ? Math.max(...updated) : null,
    lat: center.lat,
    lon: center.lon,
    bbox: {
      minLat: center.lat - half,
      minLon: center.lon - half,
      maxLat: center.lat + half,
      maxLon: center.lon + half,
    },
    title: `Heat detections in cell ${cellKey} on ${date}`,
    facts: {
      count: count(lines.length),
      cell: label(cellKey),
      date: label(date),
      satellites: label(satellites.map(satelliteName).join(" and ")),
    },
    meta: {
      satellites,
      dayKey,
      cellDeg: CELL_DEG,
      confidence: config.detectors.fireGrowth.fireConfidence,
      // The batch versions the lines were taken from.
      batches: cited.map((b) => b.id),
      // True when every reporting satellite still had a batch for both UTC dates the day spans.
      complete: satellites.every((s) => batchesFound.get(s) === dates.length),
      // Counted lines left out because their sub-cell is a persistent heat source.
      persistentLeftOut: leftOut,
      subcellsPerDeg: SUB_PER_DEG,
      digestOf: "raw",
    },
    raw,
    rawGz: null,
    rawDigest,
    fetchId: null,
    supersedes: prev?.id ?? null,
  };
  await insertEvents(db, [event], "ingest", fetchedAt);
  return event;
}

/**
 * Fire cells for the globe: counted detections with acquisition time in [from, to), summed over
 * satellites, from the latest batch versions. lat and lon are the cell center.
 */
export async function fireCellsForWindow(
  db: Db,
  from: number,
  to: number,
): Promise<Array<{ cellKey: string; lat: number; lon: number; count: number }>> {
  const counts = new Map<string, number>();
  for (const batch of await latestBatches(db, from, to)) {
    for (const r of batchRows(batch)) {
      if (r.acqMs < from || r.acqMs >= to || !COUNTED.has(r.confidence)) continue;
      const cell = cellKeyOf(r.lat, r.lon);
      counts.set(cell, (counts.get(cell) ?? 0) + 1);
    }
  }
  return [...counts]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([cellKey, n]) => ({ cellKey, ...cellCenter(cellKey), count: n }));
}

// ---------------------------------------------------------------------------------------------
// Cold start

/** The 7-day file for a satellite: the same URL with _7d instead of _24h. */
export function sevenDayUrl(satellite: FirmsSatellite): string {
  const url = config.sources.firms.files[satellite];
  const out = url.replace("_24h.csv", "_7d.csv");
  if (out === url) throw new Error(`Cannot derive the 7-day URL from ${url}`);
  return out;
}

/**
 * Presence from a 7-day file, keeping only local solar days the file covers in full at every
 * longitude, so each stored day is complete for every cell. Pure; used by bootstrapPresence.
 */
export function presenceFromRows(rows: FirmsRow[]): Map<number, SubcellCounts> {
  let first = Infinity;
  let last = -Infinity;
  for (const r of rows) {
    first = Math.min(first, r.acqMs);
    last = Math.max(last, r.acqMs);
  }
  const { counts, days } = countByDayAndSubcell(rows);
  const out = new Map<number, SubcellCounts>();
  for (const day of [...days].sort((a, b) => a - b)) {
    // A day starts earliest at the east edge (lon 180) and ends latest at the west edge (-180).
    const whole =
      solarDayStartMs(day, 180) >= first && solarDayStartMs(day, -180) + MS_PER_DAY <= last;
    if (whole) out.set(day, counts.get(day) ?? new Map());
  }
  return out;
}

/** Days stored in fire_presence. */
export async function presenceDayCount(db: Db): Promise<number> {
  const rs = await db.execute("SELECT COUNT(DISTINCT day_key) AS n FROM fire_presence");
  return Number(rs.rows[0]?.n ?? 0);
}

/**
 * Cold start: when fire_presence holds fewer than persistenceMinDays days, downloads each
 * satellite's 7-day file (about 43 MB) once and stores presence for its whole days, then
 * recomputes from stored batches. No batch events are stored from the 7-day files.
 */
export async function bootstrapPresence(db: Db, deps: RunDeps): Promise<SourceRunResult> {
  const have = await presenceDayCount(db);
  const need = config.detectors.fireGrowth.persistenceMinDays;
  if (have >= need) {
    return {
      source: SOURCE,
      fetched: 0,
      inserted: 0,
      status: "not_modified",
      message: `fire_presence already holds ${have} days`,
    };
  }
  let fetched = 0;
  let written = 0;
  try {
    for (const satellite of SATELLITES) {
      const res = await sourceFetch(db, SOURCE, sevenDayUrl(satellite), {
        method: "GET",
        headers: { "User-Agent": USER_AGENT },
        now: deps.now,
        fetchImpl: deps.fetchImpl,
        timeoutMs: BULK_TIMEOUT_MS,
      });
      if (!res.ok) throw new Error(`${satellite} 7-day GET returned HTTP ${res.status}`);
      const rows = parseFirmsCsv(await res.text());
      fetched += rows.length;
      const writes = [...presenceFromRows(rows)].map(([dayKey, subcells]) => ({
        dayKey,
        satellite,
        subcells,
      }));
      await storePresence(db, writes, deps.now);
      written += writes.length;
    }
    await recomputePresence(db, deps.now);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { source: SOURCE, fetched, inserted: 0, status: "error", message };
  }
  return {
    source: SOURCE,
    fetched,
    inserted: 0,
    status: "ok",
    message: `stored ${written} presence rows from the 7-day files`,
  };
}

// ---------------------------------------------------------------------------------------------
// Fire growth

/** What one fireGrowthDue run found, for the worker to store and log. */
export interface FireGrowthRun {
  /** Detections ready for storeDetections; both cited fire_cell_day events are already stored. */
  results: DetectionResult[];
  /** Ready day pairs that were scored. */
  scored: number;
  /** Ready day pairs not scored because the persistence history is still too short. */
  waiting: number;
  /** Findings left out because their evidence was incomplete or held a different count. */
  mismatched: number;
}

/** True once a local solar day has ended at every longitude, plus the completeness margin. */
export function dayComplete(dayKey: number, now: number): boolean {
  const margin = config.detectors.fireGrowth.completenessMarginH * MS_PER_HOUR;
  // The day ends last at the west edge of the map (longitude -180).
  return now >= solarDayStartMs(dayKey, -180) + MS_PER_DAY + margin;
}

/** Every UTC date that some cell's day0 or day1 touches, oldest first. */
export function pairDates(day0: number, day1: number): string[] {
  // Local solar days start first at the east edge (+180) and end last at the west edge (-180).
  const first = Date.parse(`${utcDay(solarDayStartMs(day0, 180))}T00:00:00Z`);
  const last = solarDayStartMs(day1, -180) + MS_PER_DAY - 1;
  const dates: string[] = [];
  for (let t = first; t <= last; t += MS_PER_DAY) dates.push(utcDay(t));
  return dates;
}

/**
 * The fire-growth detector end to end (docs/plan.md 3c) for every pair (day1 - 1, day1) that is
 * ready now: day1 is over everywhere on Earth plus completenessMarginH, and every satellite still
 * has a stored batch for each UTC date the two days touch. Persistence is judged per sub-cell from
 * the presence history before day1 + 1, with both scored days excluded; masked detections are left
 * out of the counts and the evidence alike. Unchanged data gives the same ids, so reruns store
 * nothing new.
 */
export async function fireGrowthDue(db: Db, now: number): Promise<FireGrowthRun> {
  const stored = new Map<string, Set<string>>();
  const rs = await db.execute("SELECT DISTINCT record_key FROM events WHERE kind = 'fire_batch'");
  for (const r of rs.rows) {
    const key = parseBatchKey(String(r.record_key));
    if (!key) continue;
    let dates = stored.get(key.satellite);
    if (!dates) stored.set(key.satellite, (dates = new Set()));
    dates.add(key.date);
  }
  const allDates = [...new Set([...stored.values()].flatMap((d) => [...d]))].sort();
  const first = allDates[0];
  const last = allDates[allDates.length - 1];
  const run: FireGrowthRun = { results: [], scored: 0, waiting: 0, mismatched: 0 };
  if (first === undefined || last === undefined) return run;

  const rowsCache = new Map<string, FirmsRow[]>();
  const rowsOf = (batch: EventRecord): FirmsRow[] => {
    let rows = rowsCache.get(batch.id);
    if (!rows) rowsCache.set(batch.id, (rows = batchRows(batch)));
    return rows;
  };
  for (let day1 = Date.parse(first) / MS_PER_DAY; day1 <= Date.parse(last) / MS_PER_DAY; day1++) {
    const day0 = day1 - 1;
    if (!dayComplete(day1, now)) continue;
    const need = pairDates(day0, day1);
    if (!SATELLITES.every((s) => need.every((d) => stored.get(s)?.has(d)))) continue;

    const history = await presenceHistory(db, day1 + 1, config.retention.firePresenceDays);
    const mask = persistentCells(history, [day0, day1]);
    if (mask === null) {
      run.waiting += 1;
      continue;
    }
    run.scored += 1;
    const dates: [string, string] = [solarDayLabel(day0), solarDayLabel(day1)];
    const findings = detectFireGrowth(
      await loadFireDayCounts(db, day0, mask),
      await loadFireDayCounts(db, day1, mask),
    );
    for (const f of findings) {
      const e0 = await materializeCellDay(db, f.cellKey, day0, now, mask, rowsOf);
      const e1 = await materializeCellDay(db, f.cellKey, day1, now, mask, rowsOf);
      // The evidence must be complete and hold exactly the counted lines, or a brief could cite
      // a number the cited events do not contain.
      const holds = (e: EventRecord, n: number) =>
        e.facts.count?.value === n && e.meta?.complete === true;
      if (!holds(e0, f.count0) || !holds(e1, f.count1)) {
        run.mismatched += 1;
        continue;
      }
      run.results.push(buildFireGrowthDetection(f, [e0.id, e1.id], dates, now));
    }
  }
  return run;
}
