import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { config } from "../../argus.config.ts";
import { migrate, openDb, type Db } from "../../src/db/client.ts";
import { acquireLease, getEvents, getLinks, latestVersion } from "../../src/db/queries.ts";
import type { EventRecord } from "../../src/events/types.ts";
import { storeDetections } from "../../src/ingest/detections.ts";
import type {
  FlightArea,
  FlightFetchResult,
  FlightProvider,
} from "../../src/ingest/sources/flights/adapter.ts";
import type { FetchImpl } from "../../src/ingest/types.ts";
import {
  BriefSkipped,
  createBriefTrigger,
  LEASE_NAME,
  runWorker,
  type WorkerOptions,
} from "../../src/ingest/worker.ts";

// Synthetic swarm: 5 quakes near each other (zz70000001 to zz70000005), a distant quake, and a
// quarry blast. See tests/fixtures/worker/README.md.
interface Feed {
  type: "FeatureCollection";
  metadata: Record<string, unknown>;
  features: Array<{ id: string }>;
}
const SWARM = JSON.parse(
  readFileSync(new URL("../fixtures/worker/usgs_swarm.json", import.meta.url), "utf8"),
) as Feed;
const BASE = Date.UTC(2026, 8, 24, 6); // first quake of the swarm
const MIN = 60_000;
const HOUR = 60 * MIN;

async function freshDb(): Promise<Db> {
  const db = await openDb(":memory:");
  await migrate(db);
  return db;
}

function without(feed: Feed, ...ids: string[]): Feed {
  return { ...feed, features: feed.features.filter((f) => !ids.includes(f.id)) };
}

const EMPTY_FEED: Feed = { type: "FeatureCollection", metadata: {}, features: [] };

/** Tags a request URL with its source, for order checks. */
function sourceOf(url: string): string {
  const host = new URL(url).host;
  if (host === "earthquake.usgs.gov") return "usgs";
  if (host === "eonet.gsfc.nasa.gov") return "eonet";
  if (host === "celestrak.org") return "celestrak";
  if (host === "firms.modaps.eosdis.nasa.gov") return "firms";
  return host;
}

/** USGS serves `feed()`; every other source answers 503, which adapters log and back off from. */
function fakeFetch(timeline: string[], feed: () => Feed = () => EMPTY_FEED) {
  const urls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    timeline.push(sourceOf(url));
    if (url === config.sources.usgs.url) {
      return new Response(JSON.stringify(feed()), { status: 200 });
    }
    return new Response("unavailable", { status: 503 });
  }) as FetchImpl;
  return { impl, urls };
}

/** A flights provider with no aircraft that records every area it was asked for. */
function fakeProvider(timeline: string[], now: () => number): FlightProvider {
  return {
    name: "fake",
    async fetchArea(area: FlightArea): Promise<FlightFetchResult> {
      timeline.push(`flights:${area.id}`);
      return { ok: true, now: now(), aircraft: [], requestedAt: now() };
    },
  };
}

function onceOptions(
  db: Db,
  now: number,
  timeline: string[],
  feed?: () => Feed,
): WorkerOptions & { lines: string[] } {
  const lines: string[] = [];
  return {
    db,
    once: true,
    now: () => now,
    fetchImpl: fakeFetch(timeline, feed).impl,
    flightsProvider: fakeProvider(timeline, () => now),
    log: (line) => lines.push(line),
    lines,
  };
}

async function leaseRows(db: Db) {
  const rs = await db.execute("SELECT holder, expires_at FROM worker_lease");
  return rs.rows.map((r) => ({ holder: String(r.holder), expiresAt: Number(r.expires_at) }));
}

async function detections(db: Db): Promise<EventRecord[]> {
  const rs = await db.execute(
    "SELECT id FROM events WHERE kind = 'detection' ORDER BY fetched_at, id",
  );
  return getEvents(
    db,
    rs.rows.map((r) => String(r.id)),
  );
}

// ---------------------------------------------------------------------------------------------
// Lease

test("a live lease held by another worker makes the worker exit quietly without fetching", async () => {
  const db = await freshDb();
  const now = BASE + 3 * HOUR;
  expect(await acquireLease(db, LEASE_NAME, "other-worker", 120_000, now - 1_000)).toBe(true);
  const timeline: string[] = [];
  const opts = onceOptions(db, now, timeline);

  const summary = await runWorker({ ...opts, holder: "this-worker" });

  expect(summary.ran).toBe(false);
  expect(summary.runs).toEqual([]);
  expect(timeline).toEqual([]);
  expect(opts.lines).toEqual(["ingest lease is held by another worker; exiting"]);
  expect(await leaseRows(db)).toEqual([{ holder: "other-worker", expiresAt: now + 119_000 }]);
});

test("an expired lease is taken over, and the lease is released when the run ends", async () => {
  const db = await freshDb();
  const now = BASE + 3 * HOUR;
  await acquireLease(db, LEASE_NAME, "crashed-worker", 120_000, now - 5 * MIN);
  const summary = await runWorker({ ...onceOptions(db, now, []), holder: "this-worker" });
  expect(summary.ran).toBe(true);
  expect(await leaseRows(db)).toEqual([]);
});

test("two workers started together: exactly one runs", async () => {
  const db = await freshDb();
  const now = BASE + 3 * HOUR;
  const a: string[] = [];
  const b: string[] = [];
  const [ra, rb] = await Promise.all([
    runWorker({ ...onceOptions(db, now, a), holder: "worker-a" }),
    runWorker({ ...onceOptions(db, now, b), holder: "worker-b" }),
  ]);
  expect([ra.ran, rb.ran].filter(Boolean)).toHaveLength(1);
  const ranTimeline = ra.ran ? a : b;
  const idleTimeline = ra.ran ? b : a;
  expect(ranTimeline.length).toBeGreaterThan(0);
  expect(idleTimeline).toEqual([]);
  expect(await leaseRows(db)).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Once mode

test("--once runs every source in order, then the detectors, then retention", async () => {
  const db = await freshDb();
  const timeline: string[] = [];
  const opts = onceOptions(db, BASE + 3 * HOUR, timeline);
  const summary = await runWorker(opts);

  expect(summary.ran).toBe(true);
  expect(summary.mode).toBe("once");
  // Consecutive requests of one source collapse to one entry.
  const order = timeline.filter((s, i) => s !== timeline[i - 1]);
  expect(order).toEqual([
    "usgs",
    "eonet",
    "celestrak",
    "firms",
    ...config.sources.flights.layerAreas.map((a) => `flights:${a.id}`),
    `flights:${config.sources.flights.detectorArea.id}`,
  ]);
  expect(summary.runs.map((r) => r.source)).toEqual([
    "usgs",
    "eonet",
    "celestrak",
    "firms",
    "flights-layer",
    "flights-layer",
    "flights-layer",
    "flights-sample",
    "quake-cluster",
    "fire-growth",
    "flights-batch",
    "circling",
    "retention",
  ]);
  // Failing sources are logged and the run carries on.
  const status = Object.fromEntries(summary.runs.map((r) => [r.source, r.status]));
  expect(status).toMatchObject({
    usgs: "ok",
    eonet: "error",
    celestrak: "error",
    firms: "error",
    "flights-layer": "ok",
    "quake-cluster": "ok",
    "fire-growth": "ok",
    circling: "ok",
    retention: "ok",
  });
  // One line per run: source, status, fetched, inserted, ms.
  expect(opts.lines).toHaveLength(summary.runs.length);
  for (const line of opts.lines) {
    expect(line).toMatch(/^[a-z-]+ [a-z_]+ fetched=\d+ inserted=\d+ ms=\d+( .+)?$/);
  }
  // Each layer area stored one frame; the detector batch was empty and stored nothing.
  const frames = await db.execute("SELECT COUNT(*) AS n FROM events WHERE kind = 'flight_frame'");
  expect(Number(frames.rows[0]?.n)).toBe(config.sources.flights.layerAreas.length);
  expect(summary.totals.usgs).toEqual({ runs: 1, errors: 0, fetched: 0, inserted: 0 });
});

test("a USGS swarm stores a quake-cluster detection with links, and regrowth supersedes it", async () => {
  const db = await freshDb();
  const first = without(SWARM, "zz70000005");
  const t1 = BASE + 3 * HOUR;
  const run1 = await runWorker(onceOptions(db, t1, [], () => first));
  const cluster1 = run1.runs.find((r) => r.source === "quake-cluster");
  expect(cluster1).toMatchObject({ status: "ok", inserted: 1 });

  const [d1, ...more1] = await detections(db);
  expect(more1).toEqual([]);
  expect(d1?.recordKey).toBe("argus:quake-cluster:usgs:zz70000001");
  expect(d1?.facts.count?.text).toBe("4");
  expect(d1?.facts.max_mag?.text).toBe("3.1");
  expect(d1?.supersedes).toBeNull();
  const members1 = await getLinks(db, d1?.id ?? "");
  const memberRecords1 = await getEvents(db, members1);
  expect(memberRecords1.map((e) => e.recordKey).sort()).toEqual([
    "usgs:zz70000001",
    "usgs:zz70000002",
    "usgs:zz70000003",
    "usgs:zz70000004",
  ]);

  // Ten minutes later the fifth quake arrives: same anchor, one more member, a new version.
  const t2 = t1 + 10 * MIN;
  const run2 = await runWorker(onceOptions(db, t2, [], () => SWARM));
  expect(run2.runs.find((r) => r.source === "quake-cluster")).toMatchObject({ inserted: 1 });
  const all = await detections(db);
  expect(all).toHaveLength(2);
  const d2 = await latestVersion(db, "argus:quake-cluster:usgs:zz70000001");
  expect(d2?.id).not.toBe(d1?.id);
  expect(d2?.supersedes).toBe(d1?.id);
  expect(d2?.facts.count?.text).toBe("5");
  expect(d2?.facts.max_mag?.text).toBe("3.4");
  const members2 = await getEvents(db, await getLinks(db, d2?.id ?? ""));
  expect(members2.map((e) => e.recordKey).sort()).toEqual([
    "usgs:zz70000001",
    "usgs:zz70000002",
    "usgs:zz70000003",
    "usgs:zz70000004",
    "usgs:zz70000005",
  ]);

  // The same data again stores nothing new.
  const run3 = await runWorker(onceOptions(db, t2 + 10 * MIN, [], () => SWARM));
  expect(run3.runs.find((r) => r.source === "quake-cluster")).toMatchObject({ inserted: 0 });
  expect(await detections(db)).toHaveLength(2);
});

test("a cluster whose anchor left the newest window is not stored again as a smaller one", async () => {
  const db = await freshDb();
  // Store the swarm while it is fresh, then look again 12 h 10 min after its first quake: the
  // 12 h lookback no longer holds the anchor zz70000001, and the other four quakes (anchored at
  // zz70000002, 11 h 50 min ago) must not come back as a new, smaller detection.
  await runWorker(onceOptions(db, BASE + 3 * HOUR, [], () => SWARM));
  expect(await detections(db)).toHaveLength(1);
  const late = await runWorker(onceOptions(db, BASE + 12 * HOUR + 10 * MIN, [], () => EMPTY_FEED));
  const line = late.runs.find((r) => r.source === "quake-cluster");
  expect(line).toMatchObject({ status: "ok", inserted: 0 });
  expect(line?.message).toContain("anchored before the newest window");
  expect(await detections(db)).toHaveLength(1);
});

// ---------------------------------------------------------------------------------------------
// storeDetections

test("storeDetections skips a stored id and relinks a detection that lost its links", async () => {
  const db = await freshDb();
  await runWorker(onceOptions(db, BASE + 3 * HOUR, [], () => SWARM));
  const [d] = await detections(db);
  if (!d) throw new Error("no detection stored");
  const members = await getLinks(db, d.id);
  expect(members).toHaveLength(5);

  expect(await storeDetections(db, [{ detection: d, members }])).toBe(0);
  expect(await getLinks(db, d.id)).toHaveLength(5);

  await db.execute({ sql: "DELETE FROM event_links WHERE parent_id = ?", args: [d.id] });
  expect(await storeDetections(db, [{ detection: d, members }])).toBe(0);
  expect((await getLinks(db, d.id)).sort()).toEqual([...members].sort());
});

// ---------------------------------------------------------------------------------------------
// Brief trigger

test("the default brief trigger posts the window end with the scheduler secret", async () => {
  const calls: Array<{ url: string; method?: string; secret: string | null; body: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      secret: new Headers(init?.headers).get("x-argus-scheduler"),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as FetchImpl;
  const trigger = createBriefTrigger({
    fetchImpl,
    env: { ARGUS_SCHEDULER_SECRET: "test-secret", ARGUS_APP_URL: "http://127.0.0.1:3999/" },
  });
  await trigger(BASE);
  expect(calls).toEqual([
    {
      url: "http://127.0.0.1:3999/api/brief/run",
      method: "POST",
      secret: "test-secret",
      body: { windowEnd: BASE },
    },
  ]);
});

test("the brief trigger skips without a secret or a server, and reports route errors", async () => {
  let called = 0;
  const refused = (async () => {
    called += 1;
    throw new TypeError("fetch failed");
  }) as FetchImpl;

  const noSecret = createBriefTrigger({ fetchImpl: refused, env: {} });
  const e1 = await noSecret(BASE).catch((e: unknown) => e);
  expect(e1).toBeInstanceOf(BriefSkipped);
  expect(String(e1)).toContain("ARGUS_SCHEDULER_SECRET is not set");
  expect(called).toBe(0);

  const secret = "worker-test-secret-value";
  const down = createBriefTrigger({ fetchImpl: refused, env: { ARGUS_SCHEDULER_SECRET: secret } });
  const e2 = await down(BASE).catch((e: unknown) => e);
  expect(e2).toBeInstanceOf(BriefSkipped);
  expect(String(e2)).toContain("http://localhost:3000 did not answer");
  expect(String(e2)).not.toContain(secret);

  const capped = (async () =>
    new Response(JSON.stringify({ error: "The daily brief budget is used up." }), {
      status: 429,
    })) as FetchImpl;
  const over = createBriefTrigger({ fetchImpl: capped, env: { ARGUS_SCHEDULER_SECRET: "s" } });
  const e3 = await over(BASE).catch((e: unknown) => e);
  expect(e3).not.toBeInstanceOf(BriefSkipped);
  expect(String(e3)).toContain("HTTP 429: The daily brief budget is used up.");
});
