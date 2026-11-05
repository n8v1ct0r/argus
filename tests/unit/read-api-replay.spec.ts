import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fireBatchCacheStats, fireBins } from "../../src/api/server/fires.ts";
import { flightCounts } from "../../src/api/server/flights.ts";
import { buildQuakesLayer } from "../../src/api/server/quakes.ts";
import { buildReplay, replayGaps } from "../../src/api/server/replay.ts";
import type { Db } from "../../src/db/client.ts";
import { insertEvents, logFetch } from "../../src/db/queries.ts";
import { buildDetectorBatch, buildLayerFrame } from "../../src/ingest/sources/flights/frames.ts";
import { redactAll } from "../../src/ingest/sources/flights/redact.ts";
import { createAircraftIdentity } from "../../src/ingest/sources/flights/salt.ts";
import {
  FIRMS_FETCHED,
  FIRMS_SAMPLE,
  freshDb,
  HOUR,
  MINUTE,
  seedEonet,
  seedFirms,
  seedUsgs,
  storeClusters,
  storeFeed,
  SWARM_T,
  swarmFeed,
  USGS_WINDOW,
} from "../fixtures/read-api/seed.ts";

const SEP22 = Date.UTC(2026, 8, 22);
const at = (h: number, m = 0) => SEP22 + h * HOUR + m * MINUTE;

// ---------------------------------------------------------------------------------------------
// Fires

test.describe("replay fires", () => {
  test("counted detections per 30-minute bin of acquisition time, each batch decoded once", async () => {
    const db = await freshDb();
    // A fetch id no other test uses, so the process-wide batch cache starts cold for it.
    await seedFirms(db, FIRMS_SAMPLE, "replay-bins-1");
    const day = { from: SEP22, to: SEP22 + 24 * HOUR };

    const before = fireBatchCacheStats().decodes;
    const bins = await fireBins(db, day);
    // 2026-09-22, nominal and high only: 00:10 (2), 04:30 (4), 09:30 (2), 11:30 (3), 16:40 (2), 20:48 (3).
    expect(bins).toEqual([
      { binStart: at(0), count: 2 },
      { binStart: at(4, 30), count: 4 },
      { binStart: at(9, 30), count: 2 },
      { binStart: at(11, 30), count: 3 },
      { binStart: at(16, 30), count: 2 },
      { binStart: at(20, 30), count: 3 },
    ]);
    // Only the 2026-09-22 batch overlaps the window.
    expect(fireBatchCacheStats().decodes - before).toBe(1);
    await fireBins(db, day);
    expect(fireBatchCacheStats().decodes - before).toBe(1);

    // A window that starts inside a bin: the bin starts at `from` and holds only later detections.
    expect((await fireBins(db, { from: at(0, 5), to: at(4, 30) }))[0]).toEqual({
      binStart: at(0, 5),
      count: 2,
    });
    // `to` is exclusive, as in the fires layer.
    expect(await fireBins(db, { from: at(0, 5), to: at(4, 30) })).toHaveLength(1);
  });

  test("the newest version of a batch wins", async () => {
    const db = await freshDb();
    await seedFirms(db, FIRMS_SAMPLE, "replay-bins-2");
    // FIRMS withdrew one 04:30 high-confidence detection in a later file.
    const withdrawn = "61.59,129.69,347.5,0.41,0.37,2026-09-22,0430,N20,high,2.0NRT,292.2,12.3,D";
    expect(FIRMS_SAMPLE).toContain(withdrawn);
    const later = FIRMS_SAMPLE.replace(`${withdrawn}\n`, "");
    await seedFirms(db, later, "replay-bins-3", FIRMS_FETCHED + HOUR);
    const bins = await fireBins(db, { from: SEP22, to: SEP22 + 24 * HOUR });
    expect(bins.find((b) => b.binStart === at(4, 30))?.count).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------
// Flights

test("flights: aircraft per layer poll round, summed over areas, without the detector batch", async () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/flights/point-synthetic.json", import.meta.url), "utf8"),
  ) as { now: number; ac: Record<string, unknown>[] };
  const identity = createAircraftIdentity({ randomBytes: (size) => new Uint8Array(size).fill(7) });
  const T1 = fixture.now;
  const samples = redactAll(fixture.ac, T1, (hex, t) => identity.aircraftId(hex, t));
  expect(samples).toHaveLength(3);
  const two = samples.slice(0, 2);

  const db = await freshDb();
  await insertEvents(
    db,
    [
      buildLayerFrame("london", samples, T1, null),
      buildLayerFrame("new-york", samples, T1 + 15_000, null),
      buildLayerFrame("los-angeles", two, T1 + 30_000, null),
      buildDetectorBatch("london-detector", samples, T1, T1 + 5 * MINUTE, T1 + 5 * MINUTE),
      buildLayerFrame("london", two, T1 + 10 * MINUTE, null),
      buildLayerFrame("new-york", samples, T1 + 10 * MINUTE + 15_000, null),
    ],
    "ingest",
    T1,
  );
  const counts = await flightCounts(db, { from: T1 - HOUR, to: T1 + HOUR });
  expect(counts).toEqual([
    { t: T1, count: 8 },
    { t: T1 + 10 * MINUTE, count: 5 },
  ]);
  // The window cuts frames by their time.
  expect(await flightCounts(db, { from: T1 + MINUTE, to: T1 + HOUR })).toEqual([
    { t: T1 + 10 * MINUTE, count: 5 },
  ]);
});

// ---------------------------------------------------------------------------------------------
// Quakes and natural events

test("quakes match the quakes layer, and events tick at every geometry time but wildfires", async () => {
  const db = await freshDb();
  await seedUsgs(db);
  await storeFeed(db, swarmFeed(), SWARM_T + 3 * HOUR);
  await storeClusters(db);
  await seedEonet(db);

  const replay = await buildReplay(db, { ...USGS_WINDOW, now: USGS_WINDOW.to });
  const layer = await buildQuakesLayer(db, USGS_WINDOW);
  expect(replay.quakes).toEqual(
    layer.items.map((q) => ({
      t: q.occurredAt,
      magValue: q.magValue,
      id: q.id,
      inFinding: q.inFinding,
    })),
  );
  expect(replay.quakes.filter((q) => q.inFinding)).toHaveLength(4);
  expect(replay).toMatchObject({ from: USGS_WINDOW.from, to: USGS_WINDOW.to });

  const storm = await buildReplay(db, {
    from: Date.parse("2026-09-21T00:00:00Z"),
    to: Date.parse("2026-09-22T00:00:00Z"),
    now: Date.parse("2026-09-24T00:00:00Z"),
  });
  expect(storm.events.map((e) => new Date(e.t).toISOString())).toEqual([
    "2026-09-21T00:00:00.000Z",
    "2026-09-21T06:00:00.000Z",
    "2026-09-21T12:00:00.000Z",
    "2026-09-21T18:00:00.000Z",
    "2026-09-22T00:00:00.000Z",
  ]);
  expect(new Set(storm.events.map((e) => e.id.split("@")[0]))).toEqual(
    new Set(["eonet:EONET_24721"]),
  );

  // The only geometry on 2026-09-02 is a wildfire, which the strip leaves to FIRMS.
  const fireDay = await buildReplay(db, {
    from: Date.parse("2026-09-02T00:00:00Z"),
    to: Date.parse("2026-09-03T00:00:00Z"),
    now: Date.parse("2026-09-24T00:00:00Z"),
  });
  expect(fireDay.events).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Gaps

test.describe("replay gaps", () => {
  const W0 = Date.UTC(2026, 8, 24, 0, 0);
  const W = { from: W0, to: W0 + 6 * HOUR };

  async function everyMinutes(
    db: Db,
    source: string,
    minutes: number,
    from: number,
    to: number,
    status = 200,
  ) {
    for (let t = from; t < to; t += minutes * MINUTE) await logFetch(db, source, status, 100, t);
  }

  test("error hours, and stale stretches while other sources were fetching", async () => {
    const db = await freshDb();
    await everyMinutes(db, "usgs", 5, W0, W0 + 6 * HOUR);
    // EONET: OK for 2 hours, failing for 2 hours, then silent.
    await everyMinutes(db, "eonet", 30, W0, W0 + 2 * HOUR);
    await everyMinutes(db, "eonet", 30, W0 + 2 * HOUR, W0 + 4 * HOUR, 500);
    // FIRMS: one HEAD at 10 past every hour.
    await everyMinutes(db, "firms", 60, W0 + 10 * MINUTE, W0 + 6 * HOUR);
    // CelesTrak: one fetch an hour before the window (cadence 6 h, stale after 18 h).
    await logFetch(db, "celestrak", 200, 100, W0 - HOUR);
    // Flights: never fetched.

    const gaps = await replayGaps(db, W, W.to);
    expect(gaps).toEqual([
      { layer: "flights", from: W0, to: W0 + 6 * HOUR, state: "stale" },
      { layer: "events", from: W0 + 90 * MINUTE, to: W0 + 2 * HOUR, state: "stale" },
      { layer: "events", from: W0 + 2 * HOUR, to: W0 + 4 * HOUR, state: "error" },
      { layer: "events", from: W0 + 4 * HOUR, to: W0 + 6 * HOUR, state: "stale" },
    ]);
    // Gaps end at now when the window runs past it.
    const early = await replayGaps(db, W, W0 + 3 * HOUR);
    expect(early.every((g) => g.to <= W0 + 3 * HOUR)).toBe(true);
    expect(early.find((g) => g.layer === "events" && g.state === "error")).toEqual({
      layer: "events",
      from: W0 + 2 * HOUR,
      to: W0 + 3 * HOUR,
      state: "error",
    });
  });

  test("a stopped worker is not drawn as every source going stale", async () => {
    const db = await freshDb();
    // Everything fetches for 2 hours, then nothing does.
    await everyMinutes(db, "usgs", 5, W0, W0 + 2 * HOUR);
    await everyMinutes(db, "eonet", 30, W0, W0 + 2 * HOUR);
    await everyMinutes(db, "firms", 60, W0 + 10 * MINUTE, W0 + 2 * HOUR);
    await everyMinutes(db, "flights", 10, W0, W0 + 2 * HOUR);
    await logFetch(db, "celestrak", 200, 100, W0 + 5 * MINUTE);
    expect(await replayGaps(db, W, W.to)).toEqual([]);
    // An empty log has no gaps either.
    expect(await replayGaps(await freshDb(), W, W.to)).toEqual([]);
  });

  test("the replay payload carries every trace", async () => {
    const db = await freshDb();
    const replay = await buildReplay(db, { ...W, now: W.to });
    expect(replay).toEqual({ ...W, quakes: [], fires: [], flights: [], events: [], gaps: [] });
  });
});
