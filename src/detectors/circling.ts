// Circling aircraft detector (docs/plan.md 3b). Per aircraft: keep usable samples, wrap each
// change in track to (-180, 180], reset the running sum on a gap over maxGapSeconds, and fire
// while the absolute signed sum over the last windowMinutes reaches minTurnDeg. One detection per
// episode (aircraft plus episode start); later runs over a turn that is still going produce new
// versions of the same record. The aircraft id never enters the stored detection: its id uses a
// one-way key of (aircraft, episode start), and the cited aircraft_track links it to the samples.
import { config } from "../../argus.config.ts";
import { count, label, utcTime } from "../events/facts.ts";
import type { EventRecord, Facts } from "../events/types.ts";
import { opaqueKey, sha256Hex } from "../lib/digest.ts";
import { headingDelta } from "../lib/geo.ts";
import { recordKeyOf, versionId } from "../lib/ids.ts";
import { pointsExtent } from "./quake-cluster.ts";
import type { DetectionResult, FlightSample } from "./types.ts";
import { MS_PER_MINUTE, MS_PER_SECOND } from "./units.ts";

export interface CirclingConfig {
  windowMinutes: number;
  minTurnDeg: number;
  minSpeedKt: number;
  maxGapSeconds: number;
  maxPositionAgeS: number;
}

export interface CirclingHit {
  result: DetectionResult;
  /** The episode's samples, for the worker to store as the cited aircraft_track. */
  track: FlightSample[];
}

/** A usable sample with a known track, so the turn math never sees null. */
type TrackedSample = FlightSample & { trackDeg: number };

interface Episode {
  /** Index of the sample where the turn starts. */
  start: number;
  /** Index of the sample where the accumulated turn peaks. */
  end: number;
  firstFiring: number;
  /** +1 for a right (clockwise) turn, -1 for a left turn. */
  sign: number;
}

export function detectCircling(
  samples: FlightSample[],
  areaName: string,
  cfg: CirclingConfig = config.detectors.circling,
): CirclingHit[] {
  const byAircraft = new Map<string, FlightSample[]>();
  for (const s of samples) {
    const list = byAircraft.get(s.aircraft);
    if (list) list.push(s);
    else byAircraft.set(s.aircraft, [s]);
  }

  const hits: CirclingHit[] = [];
  const aircraftIds = [...byAircraft.keys()].sort();
  for (const aircraft of aircraftIds) {
    const usable = usableSamples(byAircraft.get(aircraft) ?? [], cfg);
    for (const segment of splitOnGaps(usable, cfg.maxGapSeconds * MS_PER_SECOND)) {
      const cum = cumulativeTurn(segment);
      for (const ep of findEpisodes(segment, cum, cfg)) {
        hits.push(buildHit(aircraft, segment, cum, ep, areaName, cfg));
      }
    }
  }
  return hits;
}

function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new RangeError(`index ${i} is out of range`);
  return x;
}

/** Sorted by t, deduplicated on t (first wins), then airborne, fast, fresh, and with a track. */
function usableSamples(list: FlightSample[], cfg: CirclingConfig): TrackedSample[] {
  const sorted = [...list].sort((a, b) => a.t - b.t);
  const out: TrackedSample[] = [];
  let lastT: number | null = null;
  for (const s of sorted) {
    if (s.t === lastT) continue;
    lastT = s.t;
    if (s.onGround || s.trackDeg === null || s.groundSpeedKt === null) continue;
    if (s.groundSpeedKt < cfg.minSpeedKt || s.positionAgeS > cfg.maxPositionAgeS) continue;
    out.push({ ...s, trackDeg: s.trackDeg });
  }
  return out;
}

function splitOnGaps(samples: TrackedSample[], maxGapMs: number): TrackedSample[][] {
  const segments: TrackedSample[][] = [];
  let current: TrackedSample[] = [];
  for (const s of samples) {
    const prev = current[current.length - 1];
    if (prev && s.t - prev.t > maxGapMs) {
      segments.push(current);
      current = [];
    }
    current.push(s);
  }
  if (current.length) segments.push(current);
  return segments;
}

/** cum[i] is the signed turn from sample 0 to sample i (positive is clockwise, a right turn). */
function cumulativeTurn(segment: TrackedSample[]): number[] {
  const cum = [0];
  for (let i = 1; i < segment.length; i++) {
    cum.push(at(cum, i - 1) + headingDelta(at(segment, i - 1).trackDeg, at(segment, i).trackDeg));
  }
  return cum;
}

/**
 * A sample fires when the turn over the samples in its trailing window reaches minTurnDeg. Each
 * run of firing samples is an episode. It starts at the latest sample from which the first
 * firing window still holds a full minTurnDeg (so straight flight before the turn is trimmed) and
 * ends where the accumulated turn peaks (so straight flight after it is trimmed). A run that
 * starts inside the previous episode in the same direction extends that episode.
 */
function findEpisodes(segment: TrackedSample[], cum: number[], cfg: CirclingConfig): Episode[] {
  const windowMs = cfg.windowMinutes * MS_PER_MINUTE;
  const windowStarts: number[] = [];
  const firing: boolean[] = [];
  let windowStart = 0;
  for (const [j, s] of segment.entries()) {
    while (at(segment, windowStart).t < s.t - windowMs) windowStart++;
    windowStarts.push(windowStart);
    firing.push(Math.abs(at(cum, j) - at(cum, windowStart)) >= cfg.minTurnDeg);
  }

  const episodes: Episode[] = [];
  for (let from = 0; from < segment.length; from++) {
    if (!firing[from] || firing[from - 1]) continue;
    let lastFiring = from;
    while (firing[lastFiring + 1]) lastFiring++;

    const ws = at(windowStarts, from);
    const sign = Math.sign(at(cum, from) - at(cum, ws));
    let start = ws;
    for (let s = from - 1; s > ws; s--) {
      if (sign * (at(cum, from) - at(cum, s)) >= cfg.minTurnDeg) {
        start = s;
        break;
      }
    }

    const prev = episodes[episodes.length - 1];
    if (prev && prev.sign === sign && start <= prev.end) {
      prev.end = peakIndex(cum, prev.start, prev.firstFiring, lastFiring, sign);
    } else {
      const end = peakIndex(cum, start, from, lastFiring, sign);
      episodes.push({ start, end, firstFiring: from, sign });
    }
  }
  return episodes;
}

/** The first index in [from, to] where the turn since `start`, in direction `sign`, is largest. */
function peakIndex(cum: number[], start: number, from: number, to: number, sign: number): number {
  let best = from;
  for (let e = from + 1; e <= to; e++) {
    if (sign * (at(cum, e) - at(cum, start)) > sign * (at(cum, best) - at(cum, start))) best = e;
  }
  return best;
}

function buildHit(
  aircraft: string,
  segment: TrackedSample[],
  cum: number[],
  ep: Episode,
  areaName: string,
  cfg: CirclingConfig,
): CirclingHit {
  const track = segment.slice(ep.start, ep.end + 1);
  const startT = at(segment, ep.start).t;
  const endT = at(segment, ep.end).t;
  const totalTurn = Math.floor(Math.abs(at(cum, ep.end) - at(cum, ep.start)));
  const altitudes = track.map((s) => s.altFt).filter((a): a is number => a !== null);

  const facts: Facts = {
    total_turn_deg: count(totalTurn, "deg"),
    direction: label(ep.sign > 0 ? "right" : "left"),
    duration_s: count(Math.round((endT - startT) / MS_PER_SECOND), "s"),
    sample_count: count(track.length),
    area: label(areaName),
    start_time: utcTime(startT),
    end_time: utcTime(endT),
    ...(altitudes.length
      ? {
          min_alt_ft: count(Math.round(Math.min(...altitudes)), "ft"),
          max_alt_ft: count(Math.round(Math.max(...altitudes)), "ft"),
        }
      : {}),
  };

  // The detection's raw holds the episode samples without the aircraft id; the worker stores the
  // full redacted samples as the aircraft_track this detection cites.
  const raw = JSON.stringify({
    area: areaName,
    samples: track.map((s) => ({
      t: s.t,
      lat: s.lat,
      lon: s.lon,
      altFt: s.altFt,
      groundSpeedKt: s.groundSpeedKt,
      trackDeg: s.trackDeg,
      positionAgeS: s.positionAgeS,
    })),
  });
  const extent = pointsExtent(track);
  const nativeId = `circling:${opaqueKey(aircraft, startT)}`;

  const detection: EventRecord = {
    id: versionId("argus", nativeId, endT),
    recordKey: recordKeyOf("argus", nativeId),
    source: "argus",
    kind: "detection",
    occurredAt: endT,
    // Detections have no fetch of their own; the newest sample time stands in for it.
    fetchedAt: endT,
    sourceUpdatedAt: null,
    lat: extent.lat,
    lon: extent.lon,
    bbox: extent.bbox,
    title: `Aircraft circled near ${areaName}`,
    facts,
    meta: { detector: "circling", thresholds: cfg },
    raw,
    rawGz: null,
    rawDigest: sha256Hex(raw),
    fetchId: null,
    supersedes: null,
  };
  return { result: { detection, members: [] }, track };
}
