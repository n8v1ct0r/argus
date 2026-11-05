// Flight events. Bulk data is stored per fetch, not per point (docs/plan.md section 2): one
// flight_frame per layer poll, one flight_frame per detector batch, and one aircraft_track when
// a detection cites an aircraft. Every stored sample is re-projected onto the FlightSample
// allow-list here, so a caller that passes extra fields still cannot store them.
import { config } from "../../../../argus.config.ts";
import type { FlightSample } from "../../../detectors/types.ts";
import { count, label, upstream, utcTime } from "../../../events/facts.ts";
import type { BBox, EventRecord, Facts } from "../../../events/types.ts";
import { opaqueKey, sha256Hex } from "../../../lib/digest.ts";
import { bboxAround, KM_PER_NM } from "../../../lib/geo.ts";
import { gzipText } from "../../../lib/gzip.ts";
import { recordKeyOf, versionId } from "../../../lib/ids.ts";
import { REDACTION_VERSION } from "./redact.ts";

export const PROVIDER = "adsb.lol";

type ConfigArea =
  (typeof config.sources.flights.layerAreas)[number] | typeof config.sources.flights.detectorArea;

const AREAS: readonly ConfigArea[] = [
  ...config.sources.flights.layerAreas,
  config.sources.flights.detectorArea,
];

function areaById(areaId: string): ConfigArea {
  const area = AREAS.find((a) => a.id === areaId);
  if (!area) throw new Error(`unknown flight area: ${areaId}`);
  return area;
}

/** Allow-listed copy of a sample, keys in a fixed order. */
function project(s: FlightSample): FlightSample {
  return {
    aircraft: s.aircraft,
    t: s.t,
    lat: s.lat,
    lon: s.lon,
    altFt: s.altFt,
    groundSpeedKt: s.groundSpeedKt,
    trackDeg: s.trackDeg,
    onGround: s.onGround,
    positionAgeS: s.positionAgeS,
    category: s.category ?? null,
  };
}

/** Sorted by (aircraft, t) and deduplicated on that pair, so equal data gives an equal digest. */
function normalize(samples: FlightSample[]): FlightSample[] {
  const sorted = samples
    .map(project)
    .sort((a, b) => (a.aircraft < b.aircraft ? -1 : a.aircraft > b.aircraft ? 1 : a.t - b.t));
  return sorted.filter(
    (s, i) => i === 0 || s.aircraft !== sorted[i - 1]?.aircraft || s.t !== sorted[i - 1]?.t,
  );
}

function distinctAircraft(samples: FlightSample[]): number {
  return new Set(samples.map((s) => s.aircraft)).size;
}

function areaBox(area: ConfigArea): BBox {
  return bboxAround(area.lat, area.lon, area.radiusNm * KM_PER_NM);
}

function gzBody(samples: FlightSample[]): Pick<EventRecord, "raw" | "rawGz" | "rawDigest"> {
  const json = JSON.stringify(samples);
  return { raw: null, rawGz: gzipText(json), rawDigest: sha256Hex(json) };
}

/** One layer poll of one area: the redacted aircraft, gzipped. */
export function buildLayerFrame(
  areaId: string,
  samples: FlightSample[],
  fetchedAt: number,
  fetchId: string | null,
): EventRecord {
  const area = areaById(areaId);
  const stored = normalize(samples);
  const nativeId = `frame:${area.id}`;
  return {
    id: versionId("flights", nativeId, fetchedAt),
    recordKey: recordKeyOf("flights", nativeId),
    source: "flights",
    kind: "flight_frame",
    occurredAt: fetchedAt,
    fetchedAt,
    sourceUpdatedAt: null,
    lat: area.lat,
    lon: area.lon,
    bbox: areaBox(area),
    title: `Flights around ${area.name}`,
    facts: {
      aircraft: count(distinctAircraft(stored)),
      area: label(area.name),
      time: utcTime(fetchedAt),
    },
    meta: { areaId: area.id, provider: PROVIDER, redaction: REDACTION_VERSION },
    ...gzBody(stored),
    fetchId,
    supersedes: null,
  };
}

/** The detector area's samples over one batch window, gzipped. */
export function buildDetectorBatch(
  areaId: string,
  samples: FlightSample[],
  windowStart: number,
  windowEnd: number,
  fetchedAt: number,
): EventRecord {
  if (!(windowEnd >= windowStart)) throw new RangeError("windowEnd must not precede windowStart");
  const area = areaById(areaId);
  const stored = normalize(samples);
  // Area ids are unique across layer and detector areas ("london-detector").
  const nativeId = `frame:${area.id}`;
  return {
    id: versionId("flights", nativeId, windowEnd),
    recordKey: recordKeyOf("flights", nativeId),
    source: "flights",
    kind: "flight_frame",
    occurredAt: windowEnd,
    fetchedAt,
    sourceUpdatedAt: null,
    lat: area.lat,
    lon: area.lon,
    bbox: areaBox(area),
    title: `Detector samples around ${area.name}`,
    facts: {
      aircraft: count(distinctAircraft(stored)),
      samples: count(stored.length),
      area: label(area.name),
      start: utcTime(windowStart),
      end: utcTime(windowEnd),
    },
    meta: { areaId: area.id, provider: PROVIDER, redaction: REDACTION_VERSION, batch: "detector" },
    ...gzBody(stored),
    fetchId: null,
    supersedes: null,
  };
}

/** Mean latitude and circular mean longitude, so a track near 180 degrees stays in place. */
function centroid(samples: FlightSample[]): { lat: number; lon: number } {
  let lat = 0;
  let x = 0;
  let y = 0;
  for (const s of samples) {
    lat += s.lat;
    x += Math.cos((s.lon * Math.PI) / 180);
    y += Math.sin((s.lon * Math.PI) / 180);
  }
  return { lat: lat / samples.length, lon: (Math.atan2(y, x) * 180) / Math.PI };
}

function extent(samples: FlightSample[]): BBox {
  const lats = samples.map((s) => s.lat);
  const lons = samples.map((s) => s.lon);
  return {
    minLat: Math.min(...lats),
    minLon: Math.min(...lons),
    maxLat: Math.max(...lats),
    maxLon: Math.max(...lons),
  };
}

/**
 * One aircraft's redacted samples, saved when a detection cites them. Samples of other
 * aircraft are ignored. A longer track of the same episode is a new version of the same record.
 */
export function buildAircraftTrack(
  aircraftId: string,
  samples: FlightSample[],
  fetchedAt: number,
): EventRecord {
  const own = normalize(samples.filter((s) => s.aircraft === aircraftId));
  const first = own[0];
  const last = own[own.length - 1];
  if (!first || !last) throw new Error("a track needs at least one sample of its aircraft");
  // One aircraft per track, so the id and the raw samples leave out the aircraft id entirely.
  const nativeId = `track:${opaqueKey(aircraftId, first.t)}`;
  const raw = JSON.stringify(own, (key, value: unknown) =>
    key === "aircraft" ? undefined : value,
  );
  const altitudes = own.flatMap((s) => (s.altFt === null ? [] : [s.altFt]));
  const facts: Facts = {
    samples: count(own.length),
    start: utcTime(first.t),
    end: utcTime(last.t),
  };
  if (altitudes.length) {
    facts.min_altitude = upstream(Math.min(...altitudes), "ft");
    facts.max_altitude = upstream(Math.max(...altitudes), "ft");
  }
  return {
    id: versionId("flights", nativeId, last.t),
    recordKey: recordKeyOf("flights", nativeId),
    source: "flights",
    kind: "aircraft_track",
    occurredAt: first.t,
    fetchedAt,
    sourceUpdatedAt: last.t,
    ...centroid(own),
    bbox: extent(own),
    title: "Aircraft track",
    facts,
    meta: { provider: PROVIDER, redaction: REDACTION_VERSION },
    raw,
    rawGz: null,
    rawDigest: sha256Hex(raw),
    fetchId: null,
    supersedes: null,
  };
}
