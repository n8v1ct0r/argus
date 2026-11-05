// GET /api/layers/fires?at: fire cells for the 24 hours before `at`, and the fire trace of the
// replay strip. Both count only the confidences the fire-growth detector counts.
import { config } from "../../../argus.config.ts";
import type { Db } from "../../db/client.ts";
import { getEvents } from "../../db/queries.ts";
import { fireCellsForWindow, parseFirmsCsv } from "../../ingest/sources/firms.ts";
import { gunzipText } from "../../lib/gzip.ts";
import { MS_PER_DAY } from "../../lib/time.ts";
import type { FireCellItem, LayerPayload } from "../types.ts";
import type { Window } from "./params.ts";
import { liveDetections } from "./store.ts";

export type FiresLayer = Extract<LayerPayload, { layer: "fires" }>;

export const FIRE_GROWTH_DETECTOR = "fire-growth";
/** The layer shows detections from the 24 hours before `at`. */
export const FIRE_LAYER_WINDOW_MS = MS_PER_DAY;
/** A cell is in a finding when a fire-growth detection from the last 48 hours names it. */
export const FIRE_FINDING_LOOKBACK_MS = 2 * MS_PER_DAY;
/** Replay bins: fire detections per 30 minutes of acquisition time. */
export const FIRE_BIN_MS = 30 * 60_000;
const MS_PER_MINUTE = 60_000;
/** Parsed batches kept in memory. Batch versions are immutable, so a hit never goes stale. */
export const FIRE_BATCH_CACHE_LIMIT = 64;

const COUNTED: ReadonlySet<string> = new Set<string>(config.detectors.fireGrowth.fireConfidence);

/** "floor(lat),floor(lon)" to the cell's south-west corner. */
export function cellCorner(cellKey: string): { lat: number; lon: number } | null {
  const [a, b, extra] = cellKey.split(",");
  const lat = Number(a);
  const lon = Number(b);
  if (extra !== undefined || !a || !b || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  return { lat, lon };
}

/** Cell keys named by live fire-growth detections that occurred in [from, to]. */
async function findingCells(db: Db, from: number, to: number): Promise<Set<string>> {
  const detections = await liveDetections(db, FIRE_GROWTH_DETECTOR, from, to);
  return new Set(detections.flatMap((d) => (d.facts.cell ? [d.facts.cell.text] : [])));
}

export async function buildFiresLayer(db: Db, p: { at: number }): Promise<FiresLayer> {
  const from = p.at - FIRE_LAYER_WINDOW_MS;
  const cells = await fireCellsForWindow(db, from, p.at);
  const found = await findingCells(db, p.at - FIRE_FINDING_LOOKBACK_MS, p.at);
  const items: FireCellItem[] = [];
  for (const c of cells) {
    const corner = cellCorner(c.cellKey);
    if (!corner) continue;
    items.push({ id: c.cellKey, ...corner, count: c.count, inFinding: found.has(c.cellKey) });
  }
  return { layer: "fires", from, to: p.at, items };
}

// ---------------------------------------------------------------------------------------------
// Replay trace

/** Counted detections per acquisition minute of one batch version, oldest first. */
type MinuteCounts = ReadonlyArray<readonly [minuteMs: number, count: number]>;

const batchCache = new Map<string, MinuteCounts>();
let batchDecodes = 0;

/** Cache size and how many batches were decoded since the process started (for tests). */
export function fireBatchCacheStats(): { size: number; decodes: number } {
  return { size: batchCache.size, decodes: batchDecodes };
}

function remember(id: string, counts: MinuteCounts): void {
  if (batchCache.size >= FIRE_BATCH_CACHE_LIMIT) {
    const oldest = batchCache.keys().next();
    if (!oldest.done) batchCache.delete(oldest.value);
  }
  batchCache.set(id, counts);
}

function minuteCounts(csv: string): MinuteCounts {
  const counts = new Map<number, number>();
  for (const row of parseFirmsCsv(csv)) {
    if (!COUNTED.has(row.confidence)) continue;
    const minute = Math.floor(row.acqMs / MS_PER_MINUTE) * MS_PER_MINUTE;
    counts.set(minute, (counts.get(minute) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a - b);
}

/**
 * The newest version of every fire batch (one satellite, one UTC acquisition date) whose date
 * overlaps [from, to]. Same selection as the FIRMS adapter's fire cells.
 */
async function newestBatchIds(db: Db, w: Window): Promise<string[]> {
  const rs = await db.execute({
    sql: `SELECT id, record_key FROM events
          WHERE kind = 'fire_batch' AND occurred_at > ? AND occurred_at <= ?
          ORDER BY fetched_at DESC, source_updated_at DESC, id DESC`,
    args: [w.from - MS_PER_DAY, w.to],
  });
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const r of rs.rows) {
    const key = String(r.record_key);
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(String(r.id));
  }
  return ids;
}

/** Decodes each batch version at most once per process. */
async function batchMinuteCounts(db: Db, ids: string[]): Promise<MinuteCounts[]> {
  const missing = ids.filter((id) => !batchCache.has(id));
  for (const e of await getEvents(db, missing)) {
    const csv = e.rawGz ? gunzipText(e.rawGz) : (e.raw ?? "");
    batchDecodes += 1;
    remember(e.id, minuteCounts(csv));
  }
  return ids.flatMap((id) => {
    const counts = batchCache.get(id);
    return counts ? [counts] : [];
  });
}

/**
 * Counted fire detections per 30-minute bin of acquisition time in [from, to). Bins sit on
 * 30-minute boundaries of UTC; the first bin starts at `from` when `from` falls inside it.
 * Bins without detections are left out.
 */
export async function fireBins(
  db: Db,
  w: Window,
): Promise<Array<{ binStart: number; count: number }>> {
  const bins = new Map<number, number>();
  for (const counts of await batchMinuteCounts(db, await newestBatchIds(db, w))) {
    for (const [minute, n] of counts) {
      if (minute < w.from || minute >= w.to) continue;
      const bin = Math.max(w.from, Math.floor(minute / FIRE_BIN_MS) * FIRE_BIN_MS);
      bins.set(bin, (bins.get(bin) ?? 0) + n);
    }
  }
  return [...bins].sort(([a], [b]) => a - b).map(([binStart, count]) => ({ binStart, count }));
}
