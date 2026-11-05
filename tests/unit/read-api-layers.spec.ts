import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { config } from "../../argus.config.ts";
import { buildFiresLayer } from "../../src/api/server/fires.ts";
import { buildFlightsLayer } from "../../src/api/server/flights.ts";
import { buildEventsLayer } from "../../src/api/server/natural-events.ts";
import { buildQuakesLayer } from "../../src/api/server/quakes.ts";
import { buildStatus, sourceState } from "../../src/api/server/status.ts";
import type { Db } from "../../src/db/client.ts";
import { insertEvents, latestVersion, logFetch, logFetchError } from "../../src/db/queries.ts";
import { buildFireGrowthDetection } from "../../src/detectors/fire-growth.ts";
import type { FlightSample } from "../../src/detectors/types.ts";
import type { EventRecord } from "../../src/events/types.ts";
import { fireCellsForWindow } from "../../src/ingest/sources/firms.ts";
import { buildDetectorBatch, buildLayerFrame } from "../../src/ingest/sources/flights/frames.ts";
import { redactAll } from "../../src/ingest/sources/flights/redact.ts";
import { createAircraftIdentity } from "../../src/ingest/sources/flights/salt.ts";
import { gunzipText } from "../../src/lib/gzip.ts";
import { localSolarDayKey } from "../../src/lib/time.ts";
import {
  DAY,
  EONET_NOW,
  freshDb,
  HOUR,
  MINUTE,
  revisedSwarmQuake,
  seedEonet,
  seedFirms,
  seedUsgs,
  storeClusters,
  storeFeed,
  SWARM_IDS,
  SWARM_T,
  swarmFeed,
  USGS_T1,
  USGS_WINDOW,
} from "../fixtures/read-api/seed.ts";

// ---------------------------------------------------------------------------------------------
// Status

test.describe("status", () => {
  const NOW = Date.UTC(2026, 8, 24, 12, 0);

  test("each layer reads live, stale, or error from the fetch log", async () => {
    const db = await freshDb();
    // quakes: an OK fetch 5 minutes ago (cadence 5 min, live up to 10 min).
    await logFetch(db, "usgs", 200, 1000, NOW - 5 * MINUTE);
    // fires: last OK 3 hours ago (cadence 1 h, live up to 2 h).
    await logFetch(db, "firms", 200, 0, NOW - 3 * HOUR);
    // flights: OK in the previous hour, then HTTP 429 in this hour.
    await logFetch(db, "flights", 200, 500, NOW - 70 * MINUTE);
    await logFetch(db, "flights", 429, 0, NOW - 10 * MINUTE);
    await logFetchError(
      db,
      "flights",
      "https://example.test/x",
      429,
      "HTTP 429",
      NOW - 10 * MINUTE,
    );
    // events: OK 20 minutes ago, then a network error that never reached the fetch log.
    await logFetch(db, "eonet", 200, 800, NOW - 20 * MINUTE);
    await logFetchError(
      db,
      "eonet",
      "https://example.test/y",
      null,
      "TypeError: fetch failed",
      NOW - 5 * MINUTE,
    );
    // satellites: never fetched.

    const status = await buildStatus(db, { now: NOW });
    expect(status.now).toBe(NOW);
    expect(Object.keys(status.sources)).toEqual([
      "quakes",
      "fires",
      "flights",
      "satellites",
      "events",
    ]);
    expect(status.sources.quakes).toEqual({
      state: "live",
      lastOkAt: NOW - 5 * MINUTE,
      lastStatus: 200,
    });
    expect(status.sources.fires).toEqual({
      state: "stale",
      lastOkAt: NOW - 3 * HOUR,
      lastStatus: 200,
    });
    expect(status.sources.flights).toEqual({
      state: "error",
      lastOkAt: NOW - 70 * MINUTE,
      lastStatus: 429,
    });
    expect(status.sources.satellites).toEqual({ state: "stale", lastOkAt: null, lastStatus: null });
    expect(status.sources.events.state).toBe("error");

    // A success after the failures clears the error.
    await logFetch(db, "flights", 200, 500, NOW - 1 * MINUTE);
    await logFetch(db, "eonet", 200, 800, NOW - 1 * MINUTE);
    const later = await buildStatus(db, { now: NOW });
    expect(later.sources.flights).toEqual({
      state: "live",
      lastOkAt: NOW - MINUTE,
      lastStatus: 200,
    });
    expect(later.sources.events.state).toBe("live");
  });

  test("live ends exactly at 2 cadences", () => {
    const cadence = config.cadence.usgsSeconds * 1000;
    const h = { lastOkAt: NOW - 2 * cadence, lastStatus: 200, lastFailureAt: null };
    expect(sourceState(h, cadence, NOW)).toBe("live");
    expect(sourceState({ ...h, lastOkAt: NOW - 2 * cadence - 1 }, cadence, NOW)).toBe("stale");
    expect(sourceState({ ...h, lastStatus: 503 }, cadence, NOW)).toBe("error");
    // A failure logged before the last OK fetch is history, not the current state.
    expect(sourceState({ ...h, lastFailureAt: NOW - 3 * cadence }, cadence, NOW)).toBe("live");
    expect(
      sourceState({ lastOkAt: null, lastStatus: null, lastFailureAt: NOW }, cadence, NOW),
    ).toBe("error");
  });
});

// ---------------------------------------------------------------------------------------------
// Quakes

test.describe("quakes layer", () => {
  let db: Db;
  test.beforeEach(async () => {
    db = await freshDb();
    await seedUsgs(db);
  });

  test("newest live versions of counted quake types, with mag copied exactly", async () => {
    const layer = await buildQuakesLayer(db, USGS_WINDOW);
    expect(layer).toMatchObject({ layer: "quakes", ...USGS_WINDOW });
    // The quarry blast is left out; the other 5 quakes are in, oldest first.
    expect(layer.items.map((q) => [q.id, q.mag])).toEqual([
      ["usgs:us6000tx29@1790216016000", "5.4"],
      ["usgs:hv75042652@1790196762210", "2.57"],
      ["usgs:us6000tx3m@1790182251242", "5.7"],
      // The preferred id moved to nn00924795; the record keeps its key and shows the new version.
      ["usgs:nn00924795@1790216076000", "2.6"],
      ["usgs:ci41337919@1790192764590", "0.9"],
    ]);
    const first = layer.items[0];
    expect(first).toEqual({
      id: "usgs:us6000tx29@1790216016000",
      lon: -67.2912,
      lat: -28.7298,
      mag: "5.4",
      magValue: 5.4,
      occurredAt: 1790155274600,
      inFinding: false,
    });
    // The window filters on origin time.
    const narrow = await buildQuakesLayer(db, { from: 1790180000000, to: 1790190000000 });
    expect(narrow.items.map((q) => q.id)).toEqual(["usgs:nn00924795@1790216076000"]);
  });

  test("ended records are left out", async () => {
    const latest = await latestVersion(db, "usgs:us6000tx3m");
    if (!latest) throw new Error("seed is missing us6000tx3m");
    const tombstone: EventRecord = {
      ...latest,
      id: `usgs:us6000tx3m@deleted-${USGS_T1 + MINUTE}`,
      fetchedAt: USGS_T1 + MINUTE,
      sourceUpdatedAt: null,
      meta: { ...latest.meta, deleted: true },
      supersedes: latest.id,
    };
    await insertEvents(db, [tombstone], "ingest", USGS_T1 + MINUTE);
    const layer = await buildQuakesLayer(db, USGS_WINDOW);
    expect(layer.items.map((q) => q.id)).not.toContain(latest.id);
    expect(layer.items).toHaveLength(4);
  });

  test("inFinding marks the members of a quake cluster in the window, across revisions", async () => {
    await storeFeed(db, swarmFeed(), SWARM_T + 3 * HOUR);
    const [cluster, ...more] = await storeClusters(db);
    expect(more).toHaveLength(0);
    expect(cluster?.facts.count?.text).toBe("4");

    const layer = await buildQuakesLayer(db, USGS_WINDOW);
    const flagged = layer.items.filter((q) => q.inFinding).map((q) => q.id.split("@")[0]);
    expect(flagged.sort()).toEqual(SWARM_IDS.map((id) => `usgs:${id}`).sort());

    // A newer version of a member is still in the finding: membership follows the record.
    const revisedAt = SWARM_T + 4 * HOUR;
    await storeFeed(db, revisedSwarmQuake(1, revisedAt), revisedAt);
    const after = await buildQuakesLayer(db, USGS_WINDOW);
    const revised = after.items.find((q) => q.id === `usgs:${SWARM_IDS[1]}@${revisedAt}`);
    expect(revised).toMatchObject({ mag: "3.9", inFinding: true });
    expect(after.items.filter((q) => q.inFinding)).toHaveLength(4);

    // A window that ends before the cluster's last member holds no finding.
    const early = await buildQuakesLayer(db, { from: USGS_WINDOW.from, to: SWARM_T + 45 * MINUTE });
    expect(early.items.filter((q) => q.inFinding)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Natural events

test.describe("natural events layer", () => {
  let db: Db;
  test.beforeEach(async () => {
    db = await freshDb();
    await seedEonet(db);
  });
  const WIDE = { from: Date.parse("2026-08-20T00:00:00Z"), to: EONET_NOW };

  test("wildfires stay out unless asked for", async () => {
    const layer = await buildEventsLayer(db, { ...WIDE, wildfires: false });
    expect(layer.items.map((e) => e.id.split("@")[0])).toEqual([
      "eonet:EONET_23286",
      "eonet:EONET_23691",
      "eonet:EONET_24675",
      "eonet:EONET_24721",
    ]);
    expect(layer.items.some((e) => e.category === "Wildfires")).toBe(false);

    const all = await buildEventsLayer(db, { ...WIDE, wildfires: true });
    const fire = all.items.find((e) => e.id.startsWith("eonet:EONET_24098@"));
    expect(fire).toMatchObject({
      category: "Wildfires",
      lon: -103.7858,
      lat: 35.5693,
      bbox: null,
      occurredAt: Date.parse("2026-09-02T18:39:00Z"),
    });
    expect(all.items).toHaveLength(5);
  });

  test("a latitude-first flood polygon comes back as [west, south, east, north]", async () => {
    const layer = await buildEventsLayer(db, { ...WIDE, wildfires: false });
    const flood = layer.items.find((e) => e.id.startsWith("eonet:EONET_23691@"));
    if (!flood?.bbox) throw new Error("the flood polygon has no bbox");
    const [west, south, east, north] = flood.bbox;
    // GDACS wrote the ring latitude first; the adapter swapped it, so longitudes are near 126.
    expect(west).toBeGreaterThan(126);
    expect(east).toBeLessThan(127);
    expect(south).toBeGreaterThan(35);
    expect(north).toBeLessThan(36);
    expect(west).toBeLessThanOrEqual(east);
    expect(south).toBeLessThanOrEqual(north);
    // The point is the adapter's centroid, inside the box.
    expect(flood.lon).toBeGreaterThanOrEqual(west);
    expect(flood.lon).toBeLessThanOrEqual(east);
    expect(flood.lat).toBeGreaterThanOrEqual(south);
    expect(flood.lat).toBeLessThanOrEqual(north);
    expect(flood.category).toBe("Floods");
    expect(flood.occurredAt).toBe(Date.parse("2026-08-28T20:00:00Z"));
  });

  test("an event is drawn at its latest geometry inside the window", async () => {
    const window = {
      from: Date.parse("2026-09-21T00:00:00Z"),
      to: Date.parse("2026-09-21T13:00:00Z"),
      wildfires: false,
    };
    const layer = await buildEventsLayer(db, window);
    expect(layer.items).toHaveLength(1);
    expect(layer.items[0]).toMatchObject({
      lon: -103.6,
      lat: 15.4,
      bbox: null,
      category: "Severe Storms",
      occurredAt: Date.parse("2026-09-21T12:00:00Z"),
    });
    // The whole track in a wide window: the newest geometry.
    const wide = await buildEventsLayer(db, { ...WIDE, wildfires: false });
    expect(wide.items.find((e) => e.id.startsWith("eonet:EONET_24721@"))).toMatchObject({
      lon: -102.1,
      lat: 15.5,
      occurredAt: Date.parse("2026-09-23T18:00:00Z"),
    });
    // A window after every geometry holds nothing.
    const after = await buildEventsLayer(db, {
      from: EONET_NOW,
      to: EONET_NOW + HOUR,
      wildfires: true,
    });
    expect(after.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Fires

test.describe("fires layer", () => {
  const AT = Date.UTC(2026, 8, 23, 0, 0);

  function growthDetection(cellKey: string, day1Ms: number, lon: number) {
    const day1 = localSolarDayKey(day1Ms, lon);
    return buildFireGrowthDetection(
      {
        cellKey,
        day0: day1 - 1,
        day1,
        count0: 100,
        count1: 200,
        growthPct: 100,
        satellites: ["N20", "N21"],
      },
      [
        `firms:cell:${cellKey.replace(",", "_")}:${day1 - 1}@aaaaaaaaaaaa`,
        `firms:cell:${cellKey.replace(",", "_")}:${day1}@bbbbbbbbbbbb`,
      ],
      ["2026-09-21", "2026-09-22"],
      AT,
    ).detection;
  }

  test("cells from the 24 hours before at, at their south-west corner", async () => {
    const db = await freshDb();
    await seedFirms(db);
    const layer = await buildFiresLayer(db, { at: AT });
    expect(layer).toMatchObject({ layer: "fires", from: AT - DAY, to: AT });

    const expected = await fireCellsForWindow(db, AT - DAY, AT);
    expect(layer.items.map((c) => [c.id, c.count])).toEqual(
      expected.map((c) => [c.cellKey, c.count]),
    );
    // 2026-09-22 counted detections: Zambia 5, California 5, Yakutia 6 (low confidence left out).
    expect(layer.items.map((c) => [c.id, c.lat, c.lon, c.count])).toEqual([
      ["-10,25", -10, 25, 5],
      ["34,-119", 34, -119, 5],
      ["61,129", 61, 129, 6],
    ]);
    expect(layer.items.every((c) => !c.inFinding)).toBe(true);
  });

  test("inFinding follows fire-growth detections from the last 48 hours", async () => {
    const db = await freshDb();
    await seedFirms(db);
    const recent = growthDetection("34,-119", Date.UTC(2026, 8, 22, 20, 0), -118.5);
    const old = growthDetection("-10,25", Date.UTC(2026, 8, 18, 12, 0), 25.5);
    expect(AT - recent.occurredAt).toBeLessThan(2 * DAY);
    expect(AT - old.occurredAt).toBeGreaterThan(2 * DAY);
    await insertEvents(db, [recent, old], "ingest", AT);

    const layer = await buildFiresLayer(db, { at: AT });
    expect(layer.items.filter((c) => c.inFinding).map((c) => c.id)).toEqual(["34,-119"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Flights

test.describe("flights layer", () => {
  const FIXTURE = JSON.parse(
    readFileSync(new URL("../fixtures/flights/point-synthetic.json", import.meta.url), "utf8"),
  ) as { now: number; ac: Record<string, unknown>[] };
  const T0 = FIXTURE.now;
  const identity = createAircraftIdentity({ randomBytes: (size) => new Uint8Array(size).fill(7) });
  const idFor = (hex: string, t: number) => identity.aircraftId(hex, t);
  const london = redactAll(FIXTURE.ac, T0, idFor);

  /** The same aircraft pattern moved to another area, with other aircraft. */
  function moved(samples: FlightSample[], tag: string, dLat: number, dLon: number, dt: number) {
    return samples.map((s, i) => ({
      ...s,
      aircraft: identity.aircraftId(`${tag}${i}`, s.t + dt),
      t: s.t + dt,
      lat: s.lat + dLat,
      lon: s.lon + dLon,
    }));
  }

  function stored(frame: EventRecord): FlightSample[] {
    return JSON.parse(gunzipText(frame.rawGz ?? new Uint8Array())) as FlightSample[];
  }

  async function seedFrames(db: Db) {
    const frames = {
      // The same London aircraft, 10 minutes earlier.
      londonOld: buildLayerFrame(
        "london",
        london.map((s) => ({ ...s, t: s.t - 10 * MINUTE })),
        T0 - 10 * MINUTE,
        null,
      ),
      london: buildLayerFrame("london", london, T0, null),
      newYork: buildLayerFrame(
        "new-york",
        moved(london, "ny", -10.83, -73.33, -40 * MINUTE),
        T0 - 40 * MINUTE,
        null,
      ),
      losAngeles: buildLayerFrame(
        "los-angeles",
        moved(london, "la", -17.53, -117.96, -5 * MINUTE),
        T0 - 5 * MINUTE,
        null,
      ),
      // The detector area polls the same London aircraft again, 20 s later, several times.
      detector: buildDetectorBatch(
        "london-detector",
        [
          ...london.map((s) => ({ ...s, t: s.t + 10_000 })),
          ...london.map((s) => ({ ...s, t: s.t + 20_000, lat: s.lat + 0.01 })),
        ],
        T0 - 5 * MINUTE,
        T0 + 30_000,
        T0 + 31_000,
      ),
    };
    await insertEvents(db, Object.values(frames), "ingest", T0 + 31_000);
    return frames;
  }

  test("the newest frame per area in the last 30 minutes, one position per aircraft", async () => {
    const db = await freshDb();
    const f = await seedFrames(db);
    const at = T0 + MINUTE;
    const layer = await buildFlightsLayer(db, { at });
    expect(layer).toMatchObject({ layer: "flights", from: at - 30 * MINUTE, to: at });
    // New York's frame is 41 minutes old; the older London frame is replaced by the newer one.
    expect(layer.frameTimes).toEqual([T0 - 5 * MINUTE, T0, T0 + 30_000]);
    const frameIds = new Set(layer.items.map((i) => i.frameId));
    expect([...frameIds].sort()).toEqual([f.detector.id, f.losAngeles.id].sort());

    // Every London aircraft appears once, at its newest detector sample.
    const detectorSamples = stored(f.detector);
    const laSamples = stored(f.losAngeles);
    expect(layer.items).toHaveLength(london.length + laSamples.length);
    for (const item of layer.items) {
      const [frameId, index] = item.id.split("#");
      expect(frameId).toBe(item.frameId);
      const source = item.frameId === f.detector.id ? detectorSamples : laSamples;
      const s = source[Number(index)];
      expect(item).toEqual({
        id: `${item.frameId}#${index}`,
        frameId: item.frameId,
        lon: s?.lon,
        lat: s?.lat,
        altFt: s?.altFt,
        trackDeg: s?.trackDeg,
        t: s?.t,
      });
    }
    const londonTimes = layer.items.filter((i) => i.frameId === f.detector.id).map((i) => i.t);
    expect(londonTimes.sort()).toEqual(london.map((s) => s.t + 20_000).sort());
  });

  test("frames after at are not used, and the payload carries no aircraft digest", async () => {
    const db = await freshDb();
    const f = await seedFrames(db);
    const at = T0 - MINUTE;
    const layer = await buildFlightsLayer(db, { at });
    expect(layer.frameTimes).toEqual([T0 - 10 * MINUTE, T0 - 5 * MINUTE]);
    expect(new Set(layer.items.map((i) => i.frameId))).toEqual(
      new Set([f.londonOld.id, f.losAngeles.id]),
    );
    expect(layer.items.map((i) => i.id)).toContain(`${f.londonOld.id}#0`);

    const json =
      JSON.stringify(await buildFlightsLayer(db, { at: T0 + MINUTE })) + JSON.stringify(layer);
    const digests = Object.values(f).flatMap((frame) => stored(frame).map((s) => s.aircraft));
    expect(digests.length).toBeGreaterThan(0);
    for (const d of digests) expect(json).not.toContain(d);
    expect(json).not.toContain('"aircraft"');
    for (const hex of ["fake01", "fake02", "fake03", "FAKE-REG1", "FAKECS1"]) {
      expect(json).not.toContain(hex);
    }
  });

  test("no frame in the last 30 minutes means no aircraft", async () => {
    const db = await freshDb();
    await seedFrames(db);
    const layer = await buildFlightsLayer(db, { at: T0 + 2 * HOUR });
    expect(layer.items).toEqual([]);
    expect(layer.frameTimes).toEqual([]);
    expect(config.sources.flights.layerAreas.length).toBe(3);
  });
});
