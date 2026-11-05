// Earthquake cluster detector (docs/plan.md 3a). Anchored window: for each quake A, the members
// are A plus every quake within radiusKm of A whose origin time falls in [A, A + windowHours].
// A cluster therefore never reaches more than radiusKm from its anchor or spans more than
// windowHours. A cluster whose member set is contained in another cluster's is dropped; the rest
// each stay their own citable detection. Pure: no clock, no database.
import { config } from "../../argus.config.ts";
import { computed, count, label, utcDate, utcTime } from "../events/facts.ts";
import type { BBox, EventRecord, Fact, Facts } from "../events/types.ts";
import { canonicalJson, sha256Hex } from "../lib/digest.ts";
import { haversineKm, headingDelta } from "../lib/geo.ts";
import { recordKeyOf } from "../lib/ids.ts";
import type { DetectionResult } from "./types.ts";
import { DIGEST_ID_HEX_CHARS, DISTANCE_DECIMALS, HOURS_DECIMALS, MS_PER_HOUR } from "./units.ts";

export interface QuakeClusterConfig {
  minCount: number;
  radiusKm: number;
  windowHours: number;
  minMagnitude: number;
  quakeTypes: readonly string[];
}

interface Quake {
  event: EventRecord;
  time: number;
  lat: number;
  lon: number;
  mag: number;
  magFact: Fact;
}

interface Candidate {
  anchor: Quake;
  members: Quake[];
}

export function detectQuakeClusters(
  quakes: EventRecord[],
  cfg: QuakeClusterConfig = config.detectors.quakeCluster,
): DetectionResult[] {
  const usable = latestByRecordKey(quakes)
    .map((e) => toQuake(e, cfg))
    .filter((q): q is Quake => q !== null)
    .sort(byTimeThenId);

  const windowMs = cfg.windowHours * MS_PER_HOUR;
  const candidates: Candidate[] = [];
  for (const anchor of usable) {
    const members = usable.filter(
      (q) =>
        q.time >= anchor.time &&
        q.time <= anchor.time + windowMs &&
        haversineKm(anchor.lat, anchor.lon, q.lat, q.lon) <= cfg.radiusKm,
    );
    if (members.length >= cfg.minCount) candidates.push({ anchor, members });
  }

  const sets = candidates.map((c) => new Set(c.members.map((m) => m.event.id)));
  return candidates
    .filter((_, i) => !sets.some((other, j) => j !== i && isDominatedBy(sets, i, j)))
    .map((c) => buildDetection(c, cfg));
}

/**
 * Centroid and bounding box of nearby points, safe across the antimeridian: longitudes are
 * averaged as offsets from the first point. A box that crosses the antimeridian has
 * minLon > maxLon.
 */
export function pointsExtent(points: ReadonlyArray<{ lat: number; lon: number }>): {
  lat: number;
  lon: number;
  bbox: BBox;
} {
  const first = points[0];
  if (!first) throw new RangeError("pointsExtent needs at least one point");
  let latSum = 0;
  let offsetSum = 0;
  let minLat = first.lat;
  let maxLat = first.lat;
  let minOffset = 0;
  let maxOffset = 0;
  for (const p of points) {
    const offset = headingDelta(first.lon, p.lon);
    latSum += p.lat;
    offsetSum += offset;
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minOffset = Math.min(minOffset, offset);
    maxOffset = Math.max(maxOffset, offset);
  }
  const wrapLon = (lon: number) => headingDelta(0, lon);
  return {
    lat: latSum / points.length,
    lon: wrapLon(first.lon + offsetSum / points.length),
    bbox: {
      minLat,
      minLon: wrapLon(first.lon + minOffset),
      maxLat,
      maxLon: wrapLon(first.lon + maxOffset),
    },
  };
}

/** Keeps the newest version per upstream record, so revisions never count as extra quakes. */
function latestByRecordKey(events: EventRecord[]): EventRecord[] {
  const latest = new Map<string, EventRecord>();
  for (const e of events) {
    const prev = latest.get(e.recordKey);
    if (!prev || isNewer(e, prev)) latest.set(e.recordKey, e);
  }
  return [...latest.values()];
}

// Same order as latestVersion() in src/db/queries.ts: fetched_at, then source_updated_at.
function isNewer(a: EventRecord, b: EventRecord): boolean {
  if (a.fetchedAt !== b.fetchedAt) return a.fetchedAt > b.fetchedAt;
  const ua = a.sourceUpdatedAt ?? 0;
  const ub = b.sourceUpdatedAt ?? 0;
  if (ua !== ub) return ua > ub;
  return a.id > b.id;
}

function toQuake(e: EventRecord, cfg: QuakeClusterConfig): Quake | null {
  if (e.kind !== "earthquake" || e.meta?.deleted) return null;
  if (e.lat === null || e.lon === null) return null;
  const type = e.facts.type?.text;
  if (type === undefined || !cfg.quakeTypes.includes(type)) return null;
  const magFact = e.facts.mag;
  if (!magFact || typeof magFact.value !== "number" || !(magFact.value >= cfg.minMagnitude)) {
    return null;
  }
  return { event: e, time: e.occurredAt, lat: e.lat, lon: e.lon, mag: magFact.value, magFact };
}

function byTimeThenId(a: Quake, b: Quake): number {
  if (a.time !== b.time) return a.time - b.time;
  return a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0;
}

/**
 * Cluster i is dropped when its member set is a strict subset of cluster j's, or equal to it
 * and j came first (the earlier anchor keeps the shared set).
 */
function isDominatedBy(sets: Set<string>[], i: number, j: number): boolean {
  const mine = sets[i];
  const other = sets[j];
  if (!mine || !other || mine.size > other.size) return false;
  for (const id of mine) if (!other.has(id)) return false;
  return mine.size < other.size || j < i;
}

function round(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

function buildDetection(c: Candidate, cfg: QuakeClusterConfig): DetectionResult {
  const { anchor, members } = c;
  const thresholds = { ...cfg, quakeTypes: [...cfg.quakeTypes] };
  const memberIds = members.map((m) => m.event.id);
  const digest = sha256Hex(canonicalJson({ members: [...memberIds].sort(), thresholds }));

  let first = anchor.time;
  let last = anchor.time;
  let maxDistanceKm = 0;
  let strongest = anchor;
  for (const m of members) {
    first = Math.min(first, m.time);
    last = Math.max(last, m.time);
    maxDistanceKm = Math.max(maxDistanceKm, haversineKm(anchor.lat, anchor.lon, m.lat, m.lon));
    // Members are in time order, so a tie keeps the earliest quake.
    if (m.mag > strongest.mag) strongest = m;
  }
  const place = strongest.event.facts.place?.text;

  const facts: Facts = {
    count: count(members.length),
    max_distance_km: computed(round(maxDistanceKm, DISTANCE_DECIMALS), DISTANCE_DECIMALS, "km"),
    span_hours: computed(round((last - first) / MS_PER_HOUR, HOURS_DECIMALS), HOURS_DECIMALS, "h"),
    max_mag: { ...strongest.magFact },
    first_time: utcTime(first),
    last_time: utcTime(last),
    date: utcDate(last),
    ...(place === undefined ? {} : { place: label(place) }),
  };

  const raw = JSON.stringify({
    anchor: anchor.event.id,
    members: members.map((m) => ({
      id: m.event.id,
      mag: m.magFact.text,
      lat: m.lat,
      lon: m.lon,
      time: m.time,
    })),
  });
  const extent = pointsExtent(members);

  const detection: EventRecord = {
    id: `argus:quake-cluster:${digest.slice(0, DIGEST_ID_HEX_CHARS)}`,
    recordKey: recordKeyOf("argus", `quake-cluster:${anchor.event.recordKey}`),
    source: "argus",
    kind: "detection",
    occurredAt: last,
    fetchedAt: Math.max(...members.map((m) => m.event.fetchedAt)),
    sourceUpdatedAt: null,
    lat: extent.lat,
    lon: extent.lon,
    bbox: extent.bbox,
    title:
      place === undefined
        ? `Earthquake cluster: ${members.length} quakes`
        : `Earthquake cluster: ${members.length} quakes near ${place}`,
    facts,
    meta: { detector: "quake-cluster", thresholds, anchor: anchor.event.id },
    raw,
    rawGz: null,
    rawDigest: sha256Hex(raw),
    fetchId: null,
    supersedes: null,
  };
  return { detection, members: memberIds };
}
