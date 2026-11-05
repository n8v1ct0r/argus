// GET /api/layers/flights?at: aircraft positions from the newest stored frame of each flight
// area (the three layer areas and the detector area) in the 30 minutes up to `at`, and the
// flights trace of the replay strip.
//
// Privacy: stored samples carry a salted aircraft digest. It is used here only to keep one
// position per aircraft where areas overlap (the detector area sits inside the London area and
// holds several samples per aircraft), and it never enters a payload: item ids are
// `${frameId}#${index}`, where index is the sample's position in the stored frame.
import { config } from "../../../argus.config.ts";
import type { Db } from "../../db/client.ts";
import { getEvents, listEvents } from "../../db/queries.ts";
import type { EventRecord } from "../../events/types.ts";
import { gunzipText } from "../../lib/gzip.ts";
import type { FlightItem, LayerPayload } from "../types.ts";
import type { Window } from "./params.ts";

export type FlightsLayer = Extract<LayerPayload, { layer: "flights" }>;

/** A frame older than this before `at` is not drawn. */
export const FLIGHT_FRAME_MAX_AGE_MS = 30 * 60_000;
/** Frames of one layer poll round are polled one after another, well inside half a cadence. */
const ROUND_MS = (config.cadence.flightsLayerSeconds * 1000) / 2;
/** More frames than 30 minutes can hold, so the query never cuts a needed frame. */
const FRAME_QUERY_LIMIT = 1000;

const LAYER_AREA_IDS: readonly string[] = config.sources.flights.layerAreas.map((a) => a.id);
/** Areas drawn on the globe, in draw order: the layer areas, then the detector area. */
const DRAWN_AREA_IDS: readonly string[] = [
  ...LAYER_AREA_IDS,
  config.sources.flights.detectorArea.id,
];

function areaOf(frame: EventRecord): string | null {
  const id = frame.meta?.areaId;
  return typeof id === "string" ? id : null;
}

interface StoredSample {
  aircraft: string | null;
  t: number;
  lat: number;
  lon: number;
  altFt: number | null;
  trackDeg: number | null;
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * The redacted samples of a stored frame, index-aligned with the stored array (an unreadable
 * entry is null). Only the fields the layer draws are read.
 */
function decodeFrame(frame: EventRecord): Array<StoredSample | null> {
  const text = frame.rawGz ? gunzipText(frame.rawGz) : frame.raw;
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((s: unknown) => {
    if (typeof s !== "object" || s === null) return null;
    const r = s as Record<string, unknown>;
    const lat = finiteOrNull(r.lat);
    const lon = finiteOrNull(r.lon);
    const t = finiteOrNull(r.t);
    if (lat === null || lon === null || t === null) return null;
    return {
      aircraft: typeof r.aircraft === "string" ? r.aircraft : null,
      t,
      lat,
      lon,
      altFt: finiteOrNull(r.altFt),
      trackDeg: finiteOrNull(r.trackDeg),
    };
  });
}

/** The newest frame per drawn area with occurredAt in [at - 30 min, at], in draw order. */
async function framesAt(db: Db, at: number): Promise<EventRecord[]> {
  const recent = await listEvents(db, {
    kinds: ["flight_frame"],
    from: at - FLIGHT_FRAME_MAX_AGE_MS,
    to: at,
    order: "desc",
    withoutRaw: true,
    limit: FRAME_QUERY_LIMIT,
  });
  const chosen = new Map<string, string>();
  for (const f of recent) {
    const area = areaOf(f);
    if (area !== null && DRAWN_AREA_IDS.includes(area) && !chosen.has(area)) {
      chosen.set(area, f.id);
    }
  }
  const ids = DRAWN_AREA_IDS.flatMap((area) => {
    const id = chosen.get(area);
    return id === undefined ? [] : [id];
  });
  return getEvents(db, ids);
}

export async function buildFlightsLayer(db: Db, p: { at: number }): Promise<FlightsLayer> {
  const frames = await framesAt(db, p.at);
  // One position per aircraft: the newest sample at or before `at` across all drawn frames.
  // Anonymous samples (no digest) are kept as they are.
  const best = new Map<string, { frame: number; index: number; t: number }>();
  const picked: Array<{ frame: number; index: number }> = [];
  const decoded = frames.map(decodeFrame);
  decoded.forEach((samples, frame) => {
    samples.forEach((s, index) => {
      if (!s || s.t > p.at) return;
      if (s.aircraft === null) {
        picked.push({ frame, index });
        return;
      }
      const prev = best.get(s.aircraft);
      if (!prev || s.t > prev.t) best.set(s.aircraft, { frame, index, t: s.t });
    });
  });
  for (const b of best.values()) picked.push({ frame: b.frame, index: b.index });
  picked.sort((a, b) => a.frame - b.frame || a.index - b.index);

  const items: FlightItem[] = [];
  for (const { frame, index } of picked) {
    const f = frames[frame];
    const s = decoded[frame]?.[index];
    if (!f || !s) continue;
    items.push({
      id: `${f.id}#${index}`,
      frameId: f.id,
      lon: s.lon,
      lat: s.lat,
      altFt: s.altFt,
      trackDeg: s.trackDeg,
      t: s.t,
    });
  }
  const frameTimes = [...new Set(frames.map((f) => f.occurredAt))].sort((a, b) => a - b);
  return {
    layer: "flights",
    from: p.at - FLIGHT_FRAME_MAX_AGE_MS,
    to: p.at,
    frameTimes,
    items,
  };
}

// ---------------------------------------------------------------------------------------------
// Replay trace

/**
 * Aircraft per layer poll round, summed over the layer areas, from each frame's aircraft fact
 * (nothing is decoded). A round is the run of frames polled one after another: it closes when an
 * area repeats or half a layer cadence has passed. t is the round's first frame time.
 */
export async function flightCounts(
  db: Db,
  w: Window,
): Promise<Array<{ t: number; count: number }>> {
  const rs = await db.execute({
    sql: `SELECT occurred_at, facts, meta FROM events
          WHERE kind = 'flight_frame' AND occurred_at >= ? AND occurred_at <= ?
          ORDER BY occurred_at, id`,
    args: [w.from, w.to],
  });
  const out: Array<{ t: number; count: number }> = [];
  let round: { t: number; areas: Set<string>; count: number } | null = null;
  for (const r of rs.rows) {
    const meta = r.meta === null ? null : (JSON.parse(String(r.meta)) as Record<string, unknown>);
    const area = typeof meta?.areaId === "string" ? meta.areaId : null;
    if (area === null || meta?.batch === "detector" || !LAYER_AREA_IDS.includes(area)) continue;
    const facts = JSON.parse(String(r.facts)) as Record<string, { value?: unknown }>;
    const n = facts.aircraft?.value;
    if (typeof n !== "number" || !Number.isFinite(n)) continue;
    const t = Number(r.occurred_at);
    if (!round || round.areas.has(area) || t - round.t >= ROUND_MS) {
      if (round) out.push({ t: round.t, count: round.count });
      round = { t, areas: new Set(), count: 0 };
    }
    round.areas.add(area);
    round.count += n;
  }
  if (round) out.push({ t: round.t, count: round.count });
  return out;
}
