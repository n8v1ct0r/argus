import { expect, test } from "@playwright/test";
import { config } from "../../argus.config.ts";
import { migrate, openDb } from "../../src/db/client.ts";
import { insertEvents } from "../../src/db/queries.ts";
import { detectCircling } from "../../src/detectors/circling.ts";
import { opaqueKey } from "../../src/lib/digest.ts";
import type { FlightSample } from "../../src/detectors/types.ts";

// Synthetic aircraft ids: never a real ICAO address, registration, or callsign.
const ORBITER = "synthetic-aircraft-orbit";
const STRAIGHT = "synthetic-aircraft-straight";
const T0 = Date.UTC(2026, 8, 22, 0, 0, 0);
const STEP_MS = 30_000;
const AREA = "London";

/** Samples every 30 s from T0 with the given tracks; a null track leaves that slot empty. */
function flight(
  tracks: Array<number | null>,
  over: Partial<FlightSample> = {},
  aircraft = ORBITER,
): FlightSample[] {
  const out: FlightSample[] = [];
  for (const [i, trackDeg] of tracks.entries()) {
    if (trackDeg === null) continue;
    out.push({
      aircraft,
      t: T0 + i * STEP_MS,
      lat: 51.4 + i * 0.001,
      lon: -0.4 - i * 0.001,
      altFt: 7000 + i * 10,
      groundSpeedKt: 220,
      trackDeg: ((trackDeg % 360) + 360) % 360,
      onGround: false,
      positionAgeS: 0.3,
      ...over,
    });
  }
  return out;
}

/** Tracks that start at `start` and add each delta in turn. */
function turns(start: number, deltas: number[]): number[] {
  const tracks = [start];
  for (const d of deltas) tracks.push((tracks[tracks.length - 1] ?? start) + d);
  return tracks;
}

const straight = (n: number) => Array<number>(n).fill(0);
const repeat = (pattern: number[], times: number) => Array<number[]>(times).fill(pattern).flat();

// A standard-rate orbit (3 deg/s) sampled every 30 s is 90 deg per sample: 4 straight
// intervals, 8 turning intervals (720 deg, 4 minutes), then 8 straight intervals.
const ORBIT = turns(90, [...straight(4), ...Array<number>(8).fill(90), ...straight(8)]);

test("a 3 deg/s orbit sampled every 30 s fires once with measured facts", async () => {
  const hits = detectCircling(flight(ORBIT), AREA);
  expect(hits).toHaveLength(1);
  const { result, track } = hits[0]!;
  const d = result.detection;
  const start = T0 + 4 * STEP_MS;
  const end = T0 + 12 * STEP_MS;

  expect(d.id).toBe(`argus:circling:${opaqueKey(ORBITER, start)}@${end}`);
  expect(d.recordKey).toBe(`argus:circling:${opaqueKey(ORBITER, start)}`);
  expect(d.kind).toBe("detection");
  expect(d.source).toBe("argus");
  expect(d.title).toBe("Aircraft circled near London");
  expect(result.members).toEqual([]);
  expect(track.map((s) => s.t)).toEqual(Array.from({ length: 9 }, (_, i) => start + i * STEP_MS));

  const text = Object.fromEntries(Object.entries(d.facts).map(([k, f]) => [k, f.text]));
  expect(text).toEqual({
    total_turn_deg: "720",
    direction: "right",
    duration_s: "240",
    sample_count: "9",
    area: "London",
    start_time: "00:02 UTC",
    end_time: "00:06 UTC",
    min_alt_ft: "7040",
    max_alt_ft: "7120",
  });
  expect(d.meta).toMatchObject({ detector: "circling" });

  // The aircraft id stays out of the stored detection: id, record key, facts, meta, and raw.
  expect(JSON.stringify(d)).not.toContain(ORBITER);
  expect(JSON.stringify(d.facts)).not.toContain(ORBITER);
  expect(d.title).not.toContain(ORBITER);
  expect(d.raw).not.toContain(ORBITER);

  const db = await openDb(":memory:");
  await migrate(db);
  expect(await insertEvents(db, [d], "ingest", T0)).toBe(1);
});

test("a straight or gently weaving track does not fire", () => {
  expect(detectCircling(flight(straight(30).map(() => 270)), AREA)).toEqual([]);
  const weave = Array.from({ length: 30 }, (_, i) => (i % 2 ? 100 : 80));
  expect(detectCircling(flight(weave), AREA)).toEqual([]);
});

// A 4-minute racetrack hold: 180 deg turn (1 min), 1 min leg, 180 deg turn, 1 min leg.
const LAP = [90, 90, 0, 0, 90, 90, 0, 0];
const hold = (laps: number) => turns(0, [0, 0, 0, ...repeat(LAP, laps)]);
const HOLD_ENTRY = T0 + 3 * STEP_MS;
// The plan's first proposal. Holds turn 360 deg in 4 minutes, so these mechanics tests use it.
const AT_360 = { ...config.detectors.circling, minTurnDeg: 360 };

test("at the calibrated threshold a racetrack hold does not fire, at 360 it does", () => {
  // Calibration (argus.config.ts): 720 deg in the window, so routine holds stay out.
  expect(config.detectors.circling.minTurnDeg).toBe(720);
  expect(detectCircling(flight(hold(4)), AREA)).toEqual([]);
  expect(detectCircling(flight(hold(4)), AREA, AT_360)).toHaveLength(1);
});

test("a 4-minute racetrack hold fires inside 6 minutes at 360", () => {
  // The approach (3 intervals) plus 12 intervals of 30 s: 6 minutes of hold.
  const sixMinutes = hold(2).slice(0, 3 + 12 + 1);
  expect(sixMinutes).toHaveLength(16);
  const hits = detectCircling(flight(sixMinutes), AREA, AT_360);
  expect(hits).toHaveLength(1);
  const d = hits[0]!.result.detection;
  expect(d.facts.start_time?.value).toBe(HOLD_ENTRY);
  expect((d.facts.end_time?.value as number) - HOLD_ENTRY).toBeLessThanOrEqual(6 * 60_000);
  expect(d.facts.total_turn_deg?.text).toBe("540");
  expect(d.facts.duration_s?.text).toBe("300");

  // One sample before the first full 360 deg (3 minutes in), nothing fires yet.
  expect(detectCircling(flight(sixMinutes.slice(0, 9)), AREA, AT_360)).toEqual([]);
});

test("a hold that keeps turning stays one episode and only gains versions", () => {
  const early = detectCircling(flight(hold(2).slice(0, 16)), AREA, AT_360);
  const later = detectCircling(flight(hold(4)), AREA, AT_360);
  expect(early).toHaveLength(1);
  expect(later).toHaveLength(1);
  const [a, b] = [early[0]!.result.detection, later[0]!.result.detection];
  expect(b.recordKey).toBe(a.recordKey);
  expect(b.id).not.toBe(a.id);
  expect(b.facts.total_turn_deg?.text).toBe("1440");
  expect(b.facts.duration_s?.text).toBe("900");
});

test("a gap over maxGapSeconds resets the turn sum", () => {
  // 270 deg, one missing sample (a 60 s gap), then 270 deg more of the same turn.
  const continuous = turns(0, Array<number>(8).fill(90));
  expect(detectCircling(flight(continuous), AREA)).toHaveLength(1);
  const gapped = continuous.map((t, i) => (i === 4 ? null : t));
  expect(detectCircling(flight(gapped), AREA)).toEqual([]);
});

test("left and right turns are labeled by the sign of the summed heading change", () => {
  const right = detectCircling(flight(ORBIT), AREA);
  const left = detectCircling(flight(ORBIT.map((t) => 180 - t)), AREA);
  expect(right[0]?.result.detection.facts.direction?.text).toBe("right");
  expect(left[0]?.result.detection.facts.direction?.text).toBe("left");
  expect(left[0]?.result.detection.facts.total_turn_deg?.text).toBe("720");
});

test("slow, grounded, stale, and trackless samples are ignored; duplicates count once", () => {
  expect(detectCircling(flight(ORBIT, { groundSpeedKt: 30 }), AREA)).toEqual([]);
  expect(detectCircling(flight(ORBIT, { onGround: true }), AREA)).toEqual([]);
  expect(detectCircling(flight(ORBIT, { positionAgeS: 20 }), AREA)).toEqual([]);
  expect(detectCircling(flight(ORBIT, { trackDeg: null }), AREA)).toEqual([]);

  const doubled = [...flight(ORBIT), ...flight(ORBIT)];
  const [hit] = detectCircling(doubled, AREA);
  expect(hit?.result.detection.facts.sample_count?.text).toBe("9");
});

test("each aircraft is judged on its own samples", () => {
  const mixed = [...flight(ORBIT), ...flight(straight(21), {}, STRAIGHT)].sort((a, b) => a.t - b.t);
  const hits = detectCircling(mixed, AREA);
  expect(hits).toHaveLength(1);
  expect(hits[0]?.track.every((s) => s.aircraft === ORBITER)).toBe(true);
});
