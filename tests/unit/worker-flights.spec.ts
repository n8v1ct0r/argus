import { expect, test } from "@playwright/test";
import { config } from "../../argus.config.ts";
import { migrate, openDb, type Db } from "../../src/db/client.ts";
import { getEvents, getLinks, latestVersion } from "../../src/db/queries.ts";
import type { FlightSample } from "../../src/detectors/types.ts";
import type { EventRecord } from "../../src/events/types.ts";
import { runCirclingDetector, trimCirclingBuffer } from "../../src/ingest/detections.ts";
import type {
  FlightArea,
  FlightFetchResult,
  FlightProvider,
} from "../../src/ingest/sources/flights/adapter.ts";
import { aircraftId } from "../../src/ingest/sources/flights/salt.ts";
import type { FetchImpl } from "../../src/ingest/types.ts";
import { LEASE_TTL_MS, runWorker } from "../../src/ingest/worker.ts";
import { gunzipText } from "../../src/lib/gzip.ts";

// Synthetic aircraft only: never a real ICAO address, registration, or callsign.
const ORBITER = "synthetic-aircraft-orbit";
const STEP_MS = 30_000;
const DETECTOR = config.sources.flights.detectorArea;

async function freshDb(): Promise<Db> {
  const db = await openDb(":memory:");
  await migrate(db);
  return db;
}

async function ofKind(db: Db, kind: string): Promise<EventRecord[]> {
  const rs = await db.execute({
    sql: "SELECT id FROM events WHERE kind = ? ORDER BY fetched_at, id",
    args: [kind],
  });
  return getEvents(
    db,
    rs.rows.map((r) => String(r.id)),
  );
}

/** Tracks that start at `start` and add each delta in turn. */
function turns(start: number, deltas: number[]): number[] {
  const tracks = [start];
  for (const d of deltas) tracks.push((tracks[tracks.length - 1] ?? start) + d);
  return tracks;
}

function flight(t0: number, tracks: number[], aircraft = ORBITER): FlightSample[] {
  return tracks.map((trackDeg, i) => ({
    aircraft,
    t: t0 + i * STEP_MS,
    lat: 51.4 + i * 0.001,
    lon: -0.4 - i * 0.001,
    altFt: 7000 + i * 10,
    groundSpeedKt: 220,
    trackDeg: ((trackDeg % 360) + 360) % 360,
    onGround: false,
    positionAgeS: 0.3,
  }));
}

const straight = (n: number) => Array<number>(n).fill(0);
const turning = (n: number) => Array<number>(n).fill(90);

// ---------------------------------------------------------------------------------------------
// Circling wiring

test("a circling hit stores its track, then the detection with the track as its member", async () => {
  const db = await freshDb();
  const t0 = Date.UTC(2026, 8, 24, 8);
  // 4 straight intervals, then 8 turning intervals of 90 deg (720 deg in 4 minutes).
  const orbit = flight(t0, turns(90, [...straight(4), ...turning(8)]));
  const now = t0 + 13 * STEP_MS;

  const run = await runCirclingDetector(db, orbit, now);
  expect(run).toMatchObject({ examined: orbit.length, found: 1, stored: 1 });

  const [track, ...moreTracks] = await ofKind(db, "aircraft_track");
  const [detection, ...moreDetections] = await ofKind(db, "detection");
  expect(moreTracks).toEqual([]);
  expect(moreDetections).toEqual([]);
  if (!track || !detection) throw new Error("nothing stored");

  expect(await getLinks(db, detection.id)).toEqual([track.id]);
  expect(detection.title).toBe("Aircraft circled near London");
  expect(detection.facts.total_turn_deg?.text).toBe("720");
  expect(detection.facts.sample_count?.text).toBe("9");
  expect(detection.recordKey).toMatch(/^argus:circling:[0-9a-f]{16}$/);
  expect(track.facts.samples?.text).toBe("9");
  expect(track.fetchedAt).toBe(now);

  // Ids are cited in briefs and returned by the API: the aircraft digest appears nowhere.
  const stored = JSON.stringify([detection, track]);
  expect(stored).not.toContain(ORBITER);
  expect(detection.meta).not.toHaveProperty("aircraft");
  expect(detection.meta).toMatchObject({ detector: "circling" });
});

test("a turn that keeps going stores new versions that supersede the old ones", async () => {
  const db = await freshDb();
  const t0 = Date.UTC(2026, 8, 24, 9);
  const first = flight(t0, turns(90, [...straight(4), ...turning(8)]));
  const longer = flight(t0, turns(90, [...straight(4), ...turning(10)]));

  await runCirclingDetector(db, first, t0 + 13 * STEP_MS);
  const [d1] = await ofKind(db, "detection");
  const [k1] = await ofKind(db, "aircraft_track");

  const run = await runCirclingDetector(db, longer, t0 + 15 * STEP_MS);
  expect(run).toMatchObject({ found: 1, stored: 1 });
  const d2 = await latestVersion(db, d1?.recordKey ?? "");
  const k2 = await latestVersion(db, k1?.recordKey ?? "");
  expect(d2?.id).not.toBe(d1?.id);
  expect(d2?.supersedes).toBe(d1?.id);
  expect(d2?.facts.total_turn_deg?.text).toBe("900");
  expect(k2?.id).not.toBe(k1?.id);
  expect(k2?.supersedes).toBe(k1?.id);
  expect(await getLinks(db, d2?.id ?? "")).toEqual([k2?.id]);

  // The same samples again change nothing.
  expect(await runCirclingDetector(db, longer, t0 + 16 * STEP_MS)).toMatchObject({ stored: 0 });
  expect(await ofKind(db, "detection")).toHaveLength(2);
  expect(await ofKind(db, "aircraft_track")).toHaveLength(2);
});

test("an orbit longer than the buffer window stays one detection record across batches", async () => {
  const t0 = Date.UTC(2026, 8, 24, 11);
  // 30 minutes of a standard-rate orbit (90 deg per 30 s sample) after 2 straight intervals.
  const orbit = flight(t0, turns(0, [...straight(2), ...turning(60)]));
  const recentMs =
    (config.detectors.circling.windowMinutes * 60 + config.cadence.flightsDetectorBatchSeconds) *
    1000;
  const batchMs = config.cadence.flightsDetectorBatchSeconds * 1000;
  const end = orbit[orbit.length - 1]?.t ?? t0;

  // The worker's loop: add each batch's samples, trim the buffer, run the detector.
  const runBatches = async (trim: (buffer: FlightSample[], now: number) => FlightSample[]) => {
    const db = await freshDb();
    let buffer: FlightSample[] = [];
    for (let now = t0 + batchMs; now <= end + batchMs; now += batchMs) {
      buffer = trim([...buffer, ...orbit.filter((s) => s.t > now - batchMs && s.t <= now)], now);
      await runCirclingDetector(db, buffer, now);
    }
    return ofKind(db, "detection");
  };

  const kept = await runBatches((b, now) => trimCirclingBuffer(b, now, recentMs));
  expect(new Set(kept.map((d) => d.recordKey)).size).toBe(1);
  expect(kept.length).toBeGreaterThan(1);
  // A plain window of the same length cuts the orbit and stores its remainder as new records.
  const cut = await runBatches((b, now) => b.filter((s) => s.t >= now - recentMs));
  expect(new Set(cut.map((d) => d.recordKey)).size).toBeGreaterThan(1);
});

test("the circling buffer drops aircraft not seen recently and tracks cut by a gap", () => {
  const t0 = Date.UTC(2026, 8, 24, 12);
  const recentMs = 11 * 60_000;
  const now = t0 + 40 * STEP_MS;
  const gone = flight(t0, turns(0, straight(10)), "synthetic-aircraft-gone");
  // A track with one 60 s gap (over maxGapSeconds) 10 samples before now.
  const gapped = flight(t0, turns(0, straight(41)), "synthetic-aircraft-gapped").filter(
    (_, i) => i !== 30,
  );
  const kept = trimCirclingBuffer([...gone, ...gapped], now, recentMs);
  expect(kept.some((s) => s.aircraft === "synthetic-aircraft-gone")).toBe(false);
  expect(kept.map((s) => s.t)).toEqual(
    gapped.filter((s) => s.t > t0 + 30 * STEP_MS && s.t <= now).map((s) => s.t),
  );
});

test("straight flight stores nothing", async () => {
  const db = await freshDb();
  const t0 = Date.UTC(2026, 8, 24, 10);
  const run = await runCirclingDetector(db, flight(t0, turns(270, straight(20))), t0);
  expect(run).toMatchObject({ found: 0, stored: 0 });
  expect(await ofKind(db, "detection")).toEqual([]);
  expect(await ofKind(db, "aircraft_track")).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Loop mode on a fake clock

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A timer queue on a fake clock. Every lane of the worker sleeps through `sleep`; `runUntil`
 * waits until all lanes are asleep, then fires the earliest timer, so each step runs at exactly
 * its scheduled time.
 */
class FakeTimers {
  t: number;
  private timers: Array<{ at: number; seq: number; resolve: () => void }> = [];
  private seq = 0;
  constructor(start: number) {
    this.t = start;
  }
  now = () => this.t;
  sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = { at: this.t + ms, seq: this.seq++, resolve };
      this.timers.push(timer);
      signal.addEventListener(
        "abort",
        () => {
          this.timers = this.timers.filter((x) => x !== timer);
          resolve();
        },
        { once: true },
      );
    });
  async runUntil(end: number, sleepers: number): Promise<void> {
    for (;;) {
      await this.idle(sleepers);
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers[0];
      if (!next || next.at > end) return;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.resolve();
    }
  }
  private async idle(sleepers: number): Promise<void> {
    for (let i = 0; i < 5000; i++) {
      if (this.timers.length >= sleepers) {
        await tick();
        if (this.timers.length >= sleepers) return;
      }
      await tick();
    }
    throw new Error(`only ${this.timers.length} of ${sleepers} lanes went to sleep`);
  }
}

/** One aircraft circling in the detector area; two steady aircraft in each layer area. */
function orbitingProvider(clock: FakeTimers, start: number) {
  const calls: Array<{ area: string; at: number }> = [];
  const state = { inFlight: 0, maxInFlight: 0 };
  const provider: FlightProvider = {
    name: "fake",
    async fetchArea(area: FlightArea): Promise<FlightFetchResult> {
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      calls.push({ area: area.id, at: clock.t });
      await tick();
      state.inFlight -= 1;
      const k = Math.round((clock.t - start) / STEP_MS);
      const aircraft =
        area.id === DETECTOR.id
          ? [
              {
                hex: "synthetic-orbit",
                lat: 51.47 + k * 0.001,
                lon: -0.45,
                alt_baro: 7000,
                gs: 220,
                // Straight until sample 2, then 90 deg a sample until sample 10 (720 deg).
                track: (90 + 90 * Math.min(Math.max(k - 2, 0), 8)) % 360,
                seen_pos: 0.3,
                category: "A3",
              },
            ]
          : ["synthetic-a", "synthetic-b"].map((hex, i) => ({
              hex,
              lat: area.lat + i * 0.1,
              lon: area.lon,
              alt_baro: 30000,
              gs: 450,
              track: 90,
              seen_pos: 1,
              category: "A3",
            }));
      return { ok: true, now: clock.t, aircraft, requestedAt: clock.t };
    },
  };
  return { provider, calls, state };
}

test("loop mode keeps the flights grid, stores batches and circling, briefs on the hour, and releases the lease", async () => {
  const db = await freshDb();
  // One minute before a brief boundary, so the hourly brief falls inside the run.
  const start = Date.UTC(2026, 8, 24, 12, 59, 0);
  const clock = new FakeTimers(start);
  const flights = orbitingProvider(clock, start);
  const sourceUrls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    sourceUrls.push(String(input));
    return new Response("unavailable", { status: 503 });
  }) as FetchImpl;
  const briefs: number[] = [];
  const lines: string[] = [];
  const controller = new AbortController();

  const done = runWorker({
    db,
    once: false,
    now: clock.now,
    sleep: clock.sleep,
    fetchImpl,
    flightsProvider: flights.provider,
    signal: controller.signal,
    log: (line) => lines.push(line),
    holder: "loop-test",
    briefTrigger: async (windowEnd) => {
      briefs.push(windowEnd);
    },
    bootstrapFirePresence: false,
  });

  // 4 lanes sleep between steps: sources, flights, brief, lease.
  await clock.runUntil(start + 10 * STEP_MS + 15_000, 4);

  const lease = await db.execute("SELECT holder, expires_at FROM worker_lease");
  expect(lease.rows.map((r) => [String(r.holder), Number(r.expires_at)])).toEqual([
    ["loop-test", start + 10 * STEP_MS + LEASE_TTL_MS],
  ]);

  controller.abort();
  const summary = await done;
  expect(summary).toMatchObject({ mode: "loop", ran: true });
  expect((await db.execute("SELECT * FROM worker_lease")).rows).toHaveLength(0);

  // Detector samples on the 30 s grid; one layer area right after each of the first 3 samples.
  const detectorTimes = flights.calls.filter((c) => c.area === DETECTOR.id).map((c) => c.at);
  expect(detectorTimes).toEqual(Array.from({ length: 11 }, (_, k) => start + k * STEP_MS));
  expect(flights.calls.slice(0, 7)).toEqual([
    { area: DETECTOR.id, at: start },
    { area: "london", at: start },
    { area: DETECTOR.id, at: start + STEP_MS },
    { area: "new-york", at: start + STEP_MS },
    { area: DETECTOR.id, at: start + 2 * STEP_MS },
    { area: "los-angeles", at: start + 2 * STEP_MS },
    { area: DETECTOR.id, at: start + 3 * STEP_MS },
  ]);
  expect(flights.state.maxInFlight).toBe(1);

  // Frames: 3 layer areas plus one detector batch at 300 s holding 11 samples.
  const frames = await ofKind(db, "flight_frame");
  expect(frames.map((f) => f.meta?.areaId)).toEqual([
    "london",
    "new-york",
    "los-angeles",
    DETECTOR.id,
  ]);
  const batch = frames[3];
  expect(batch?.facts.samples?.text).toBe("11");
  expect(batch?.occurredAt).toBe(start + 10 * STEP_MS);

  // The batch triggered circling: one track, one detection citing it, no aircraft digest.
  const [track] = await ofKind(db, "aircraft_track");
  const [detection] = await ofKind(db, "detection");
  expect(track).toBeDefined();
  expect(await getLinks(db, detection?.id ?? "")).toEqual([track?.id]);
  const digest = aircraftId("synthetic-orbit", start);
  expect(gunzipText(batch?.rawGz ?? new Uint8Array())).toContain(digest);
  expect(JSON.stringify([detection, track])).not.toContain(digest);

  // The brief ran once, for the window ending on the hour.
  expect(briefs).toEqual([Date.UTC(2026, 8, 24, 13, 0, 0)]);

  // Sources ran at start and USGS again at 300 s; retention ran once; errors did not stop anything.
  expect(summary.totals.usgs).toMatchObject({ runs: 2, errors: 2 });
  expect(summary.totals["quake-cluster"]).toMatchObject({ runs: 2, errors: 0 });
  expect(summary.totals.eonet?.runs).toBe(1);
  expect(summary.totals.retention?.runs).toBe(1);
  expect(summary.totals["flights-sample"]?.runs).toBe(11);
  expect(summary.totals.circling).toMatchObject({ runs: 1, inserted: 1 });
  expect(sourceUrls.some((u) => u.startsWith(config.sources.usgs.url))).toBe(true);
  expect(lines.every((l) => !l.includes(digest))).toBe(true);
});
