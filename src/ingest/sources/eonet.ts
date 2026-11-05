// NASA EONET v3 natural events (docs/plan.md section 1c). One immutable version per event
// content: the version id hashes the sanitized event, so re-fetching unchanged data writes
// nothing. Sanitation fixes the measured upstream problems before anything is hashed or stored.
import { config } from "../../../argus.config.ts";
import type { Db } from "../../db/client.ts";
import {
  getBackoff,
  insertEvents,
  latestVersion,
  logFetchError,
  recordFailure,
  recordSuccess,
  WriteBudgetExceeded,
} from "../../db/queries.ts";
import { label, upstream, utcDate } from "../../events/facts.ts";
import type { BBox, EventRecord, Facts } from "../../events/types.ts";
import { canonicalJson, sha256Hex } from "../../lib/digest.ts";
import { recordKeyOf, versionId } from "../../lib/ids.ts";
import { MS_PER_HOUR } from "../../lib/time.ts";
import { sourceFetch } from "../http.ts";
import type { RunDeps, SourceRunResult } from "../types.ts";

const SOURCE = "eonet";

/** The events feed. The body is JSON even though Content-Type says application/rss+xml. */
export const EONET_EVENTS_URL = `${config.sources.eonet.url}?status=all&days=${config.sources.eonet.days}`;

/** Upstream source titles ("GDACS" to its full name). Resolves to .../api/v3/sources. */
export const EONET_SOURCES_URL = new URL("sources", config.sources.eonet.url).toString();

// The approved contact User-Agent (plan decision 4). It lives under flights in the config
// because adsb.lol is the source that enforces it; every Argus request sends the same one.
const REQUEST_HEADERS = { "User-Agent": config.userAgent };

/** GDACS stores flood polygons latitude first (57 of 57 in a 30-day sample, plan 1c). */
const LAT_FIRST_POLYGON_SOURCE = "GDACS";

/** Geometries dated further ahead than this are dropped (1 measured in a 30-day sample). */
const FUTURE_TOLERANCE_MS = MS_PER_HOUR;

/** A ring needs at least a triangle's worth of positions to enclose an area. */
const MIN_RING_POSITIONS = 3;

/** Hex characters of the content digest used as the version. */
const VERSION_HEX_CHARS = 12;

// Backoff after an upstream failure: starts at one cadence, doubles, capped at 8 cadences.
const BACKOFF_BASE_MS = config.cadence.eonetSeconds * 1000;
const BACKOFF_MAX_MS = 8 * BACKOFF_BASE_MS;

export type LonLat = [lon: number, lat: number];

interface GeometryBase {
  /** Upstream ISO date string, as received. */
  date: string;
  /** The same date in ms UTC. */
  time: number;
  magnitudeValue: number | string | null;
  magnitudeUnit: string | null;
}

export interface EonetPoint extends GeometryBase {
  type: "Point";
  coordinates: LonLat;
}

export interface EonetPolygon extends GeometryBase {
  type: "Polygon";
  /** Rings of [lon, lat] positions; the first ring is the outer boundary. */
  coordinates: LonLat[][];
}

export type EonetGeometry = EonetPoint | EonetPolygon;

/**
 * An EONET event after sanitation: positions are [lon, lat] and on Earth, no geometry is dated
 * more than an hour ahead of the fetch, and geometries are ordered oldest first. Rebuild it
 * from a stored row with sanitizeEonetEvent(JSON.parse(raw), fetchedAt).
 */
export interface SanitizedEvent {
  id: string;
  title: string;
  closed: string | null;
  categories: { id: string; title: string }[];
  sources: { id: string; url: string }[];
  geometry: EonetGeometry[];
}

export interface EonetSourceInfo {
  title: string;
  url: string;
}

/** Upstream source id to its title and home page. */
export type EonetSourcesMap = ReadonlyMap<string, EonetSourceInfo>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function position(v: unknown): LonLat | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const [a, b] = v as unknown[];
  if (typeof a !== "number" || typeof b !== "number") return null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return [a, b];
}

function onEarth([lon, lat]: LonLat): boolean {
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/** A ring with every position swapped (when latitude first) and on Earth, or null. */
function sanitizeRing(v: unknown, latFirst: boolean): LonLat[] | null {
  if (!Array.isArray(v) || v.length < MIN_RING_POSITIONS) return null;
  const ring: LonLat[] = [];
  for (const p of v) {
    const pos = position(p);
    if (!pos) return null;
    const lonLat: LonLat = latFirst ? [pos[1], pos[0]] : pos;
    if (!onEarth(lonLat)) return null;
    ring.push(lonLat);
  }
  return ring;
}

function magnitudeOf(v: unknown): number | string | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return nonEmpty(v);
}

function sanitizeGeometry(g: unknown, latFirst: boolean, now: number): EonetGeometry | null {
  if (!isRecord(g)) return null;
  const date = nonEmpty(g.date);
  if (!date) return null;
  const time = Date.parse(date);
  if (!Number.isFinite(time) || time > now + FUTURE_TOLERANCE_MS) return null;
  const base: GeometryBase = {
    date,
    time,
    magnitudeValue: magnitudeOf(g.magnitudeValue),
    magnitudeUnit: nonEmpty(g.magnitudeUnit),
  };
  if (g.type === "Point") {
    const pos = position(g.coordinates);
    return pos && onEarth(pos) ? { ...base, type: "Point", coordinates: pos } : null;
  }
  if (g.type === "Polygon") {
    if (!Array.isArray(g.coordinates)) return null;
    const rings = g.coordinates.map((r: unknown) => sanitizeRing(r, latFirst));
    // Holes without their outer ring describe nothing, so a rejected outer ring drops the polygon.
    if (!rings[0]) return null;
    return {
      ...base,
      type: "Polygon",
      coordinates: rings.filter((r): r is LonLat[] => r !== null),
    };
  }
  return null;
}

/**
 * Validates one upstream EONET event and fixes the measured problems: GDACS polygons are
 * swapped to [lon, lat], rings still off Earth are rejected, geometries dated more than 1 hour
 * after `now` are dropped. Returns null when the event is malformed or has no geometry left.
 * Pure: the same input and `now` always give the same output.
 */
export function sanitizeEonetEvent(ev: unknown, now: number): SanitizedEvent | null {
  if (!isRecord(ev) || !Array.isArray(ev.geometry)) return null;
  const id = nonEmpty(ev.id);
  const title = nonEmpty(ev.title);
  // The id becomes part of a version id, so it must not contain the "@" separator or spaces.
  if (!id || !/^[\w.-]+$/.test(id) || !title) return null;

  const categories: SanitizedEvent["categories"] = [];
  for (const c of Array.isArray(ev.categories) ? ev.categories : []) {
    if (!isRecord(c)) continue;
    const cid = nonEmpty(c.id);
    const ctitle = nonEmpty(c.title);
    if (cid && ctitle) categories.push({ id: cid, title: ctitle });
  }

  const sources: SanitizedEvent["sources"] = [];
  for (const s of Array.isArray(ev.sources) ? ev.sources : []) {
    if (!isRecord(s)) continue;
    const sid = nonEmpty(s.id);
    if (sid) sources.push({ id: sid, url: typeof s.url === "string" ? s.url : "" });
  }

  const latFirst = sources.some((s) => s.id === LAT_FIRST_POLYGON_SOURCE);
  const geometry = ev.geometry
    .map((g: unknown) => sanitizeGeometry(g, latFirst, now))
    .filter((g): g is EonetGeometry => g !== null)
    // Array.prototype.sort is stable, so same-date geometries keep their upstream order.
    .sort((a, b) => a.time - b.time);
  if (!geometry.length) return null;

  return { id, title, closed: nonEmpty(ev.closed), categories, sources, geometry };
}

/** Maps the /api/v3/sources response to id -> { title, url }. Entries without a title are skipped. */
export function parseEonetSources(json: unknown): Map<string, EonetSourceInfo> {
  const out = new Map<string, EonetSourceInfo>();
  const list = isRecord(json) && Array.isArray(json.sources) ? json.sources : null;
  if (!list) throw new Error("EONET sources response has no sources array");
  for (const s of list) {
    if (!isRecord(s)) continue;
    const id = nonEmpty(s.id);
    const title = nonEmpty(s.title);
    if (!id || !title) continue;
    const url = nonEmpty(s.source) ?? nonEmpty(s.link) ?? "";
    out.set(id, { title, url });
  }
  return out;
}

function eventsOf(json: unknown): unknown[] {
  if (isRecord(json) && Array.isArray(json.events)) return json.events;
  throw new Error("EONET events response has no events array");
}

function ringBBox(ring: LonLat[]): BBox {
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (const [lon, lat] of ring) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  }
  return { minLat, minLon, maxLat, maxLon };
}

function vertexMean(ring: LonLat[]): LonLat {
  const [first] = ring;
  const last = ring[ring.length - 1];
  const closed = ring.length > 1 && first && last && first[0] === last[0] && first[1] === last[1];
  const pts = closed ? ring.slice(0, -1) : ring;
  let lon = 0;
  let lat = 0;
  for (const p of pts) {
    lon += p[0];
    lat += p[1];
  }
  return [lon / pts.length, lat / pts.length];
}

/**
 * Area centroid of a ring in the lon/lat plane (shoelace, translated to the first vertex for
 * precision). Falls back to the vertex mean when the ring has no area. Rings that cross the
 * antimeridian are not unwrapped.
 */
function ringCentroid(ring: LonLat[], bbox: BBox): LonLat {
  const [origin] = ring;
  if (!origin) throw new Error("empty ring");
  const [ox, oy] = origin;
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  let prev = ring[ring.length - 1] ?? origin;
  for (const cur of ring) {
    const x0 = prev[0] - ox;
    const y0 = prev[1] - oy;
    const x1 = cur[0] - ox;
    const y1 = cur[1] - oy;
    const cross = x0 * y1 - x1 * y0;
    twiceArea += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
    prev = cur;
  }
  if (twiceArea !== 0) {
    const lon = ox + cx / (3 * twiceArea);
    const lat = oy + cy / (3 * twiceArea);
    const inside =
      lon >= bbox.minLon && lon <= bbox.maxLon && lat >= bbox.minLat && lat <= bbox.maxLat;
    if (inside) return [lon, lat];
  }
  return vertexMean(ring);
}

function placeOf(g: EonetGeometry): { lat: number; lon: number; bbox: BBox | null } {
  if (g.type === "Point") return { lon: g.coordinates[0], lat: g.coordinates[1], bbox: null };
  const [outer] = g.coordinates;
  if (!outer) throw new Error("polygon without an outer ring");
  const bbox = ringBBox(outer);
  const [lon, lat] = ringCentroid(outer, bbox);
  return { lat, lon, bbox };
}

function toRecord(
  ev: unknown,
  s: SanitizedEvent,
  sourcesMap: EonetSourcesMap,
  fetchedAt: number,
  fetchId: string | null,
): EventRecord {
  const newest = s.geometry.at(-1);
  if (!newest) throw new Error(`EONET event ${s.id} has no geometry`);
  const { lat, lon, bbox } = placeOf(newest);

  const facts: Facts = { title: label(s.title) };
  const [category] = s.categories;
  if (category) facts.category = label(category.title);
  if (s.sources.length) {
    facts.source = label(s.sources.map((x) => sourcesMap.get(x.id)?.title ?? x.id).join(", "));
  }
  facts.date = utcDate(newest.time);
  if (newest.magnitudeValue !== null) {
    facts.magnitude = upstream(newest.magnitudeValue, newest.magnitudeUnit ?? undefined);
    if (newest.magnitudeUnit) facts.magnitude_unit = label(newest.magnitudeUnit);
  }

  const raw = JSON.stringify(ev);
  const version = sha256Hex(canonicalJson(s)).slice(0, VERSION_HEX_CHARS);
  return {
    id: versionId(SOURCE, s.id, version),
    recordKey: recordKeyOf(SOURCE, s.id),
    source: SOURCE,
    kind: "natural_event",
    occurredAt: newest.time,
    fetchedAt,
    sourceUpdatedAt: newest.time,
    lat,
    lon,
    bbox,
    title: s.title,
    facts,
    meta: {
      categories: s.categories,
      sources: s.sources,
      closed: s.closed,
      geometry_count: s.geometry.length,
    },
    raw,
    rawGz: null,
    rawDigest: sha256Hex(raw),
    fetchId,
    supersedes: null,
  };
}

/**
 * Turns an EONET events response into event versions, one per event whose sanitized content
 * is valid. Pure; throws when the response has no events array. `supersedes` is left null
 * because only the store knows the previous version.
 */
export function normalizeEonet(
  json: unknown,
  sourcesMap: EonetSourcesMap,
  fetchedAt: number,
  fetchId: string | null,
  now: number,
): EventRecord[] {
  const out: EventRecord[] = [];
  const seen = new Set<string>();
  for (const ev of eventsOf(json)) {
    const s = sanitizeEonetEvent(ev, now);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(toRecord(ev, s, sourcesMap, fetchedAt, fetchId));
  }
  return out;
}

type JsonResult =
  { ok: true; json: unknown } | { ok: false; status: number | null; message: string };

/** GETs a URL through sourceFetch and parses the body as JSON, logging parse failures. */
async function getJson(db: Db, url: string, deps: RunDeps): Promise<JsonResult> {
  let res: Response;
  try {
    res = await sourceFetch(db, SOURCE, url, {
      now: deps.now,
      headers: REQUEST_HEADERS,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  } catch (err) {
    // sourceFetch already logged the network error.
    return { ok: false, status: null, message: String(err) };
  }
  if (!res.ok) {
    // sourceFetch already logged the HTTP error.
    await res.body?.cancel();
    return { ok: false, status: res.status, message: `HTTP ${res.status}` };
  }
  try {
    return { ok: true, json: JSON.parse(await res.text()) };
  } catch (err) {
    const message = `Unreadable JSON body: ${String(err)}`;
    await logFetchError(db, SOURCE, url, res.status, message, deps.now);
    return { ok: false, status: res.status, message };
  }
}

/**
 * One EONET ingest pass: source titles (once per run), then the events feed. Stores only new
 * versions, links each to the version it supersedes, and backs off after an upstream failure.
 */
export async function runEonet(db: Db, deps: RunDeps): Promise<SourceRunResult> {
  const { now } = deps;
  const backoff = await getBackoff(db, SOURCE);
  if (backoff && backoff.nextAllowedAt > now) {
    return {
      source: SOURCE,
      fetched: 0,
      inserted: 0,
      status: "skipped_backoff",
      message: `Backing off until ${new Date(backoff.nextAllowedAt).toISOString()}`,
    };
  }

  const fail = async (status: number | null, message: string): Promise<SourceRunResult> => {
    await recordFailure(db, SOURCE, status, BACKOFF_BASE_MS, BACKOFF_MAX_MS, now);
    return { source: SOURCE, fetched: 0, inserted: 0, status: "error", message };
  };

  const sourcesRes = await getJson(db, EONET_SOURCES_URL, deps);
  if (!sourcesRes.ok)
    return fail(sourcesRes.status, `Sources request failed: ${sourcesRes.message}`);
  let sourcesMap: EonetSourcesMap;
  try {
    sourcesMap = parseEonetSources(sourcesRes.json);
  } catch (err) {
    await logFetchError(db, SOURCE, EONET_SOURCES_URL, null, String(err), now);
    return fail(null, String(err));
  }

  const eventsRes = await getJson(db, EONET_EVENTS_URL, deps);
  if (!eventsRes.ok) return fail(eventsRes.status, `Events request failed: ${eventsRes.message}`);
  let seen: number;
  let records: EventRecord[];
  try {
    seen = eventsOf(eventsRes.json).length;
    records = normalizeEonet(
      eventsRes.json,
      sourcesMap,
      now,
      `${SOURCE}@${new Date(now).toISOString()}`,
      now,
    );
  } catch (err) {
    await logFetchError(db, SOURCE, EONET_EVENTS_URL, null, String(err), now);
    return fail(null, String(err));
  }

  const fresh: EventRecord[] = [];
  for (const r of records) {
    const latest = await latestVersion(db, r.recordKey);
    if (latest?.id === r.id) continue;
    fresh.push(latest ? { ...r, supersedes: latest.id } : r);
  }

  let inserted: number;
  try {
    inserted = await insertEvents(db, fresh, "ingest", now);
  } catch (err) {
    if (!(err instanceof WriteBudgetExceeded)) throw err;
    return { source: SOURCE, fetched: seen, inserted: 0, status: "error", message: err.message };
  }
  if (backoff) await recordSuccess(db, SOURCE);

  return {
    source: SOURCE,
    fetched: seen,
    inserted,
    status: "ok",
    message: `Kept ${records.length} of ${seen} events, stored ${inserted} new versions`,
  };
}
