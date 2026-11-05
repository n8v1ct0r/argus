import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { migrate, openDb, type Db } from "../../src/db/client.ts";
import { getBackoff, getEvents, latestVersion, listEvents } from "../../src/db/queries.ts";
import type { EventRecord } from "../../src/events/types.ts";
import {
  EONET_EVENTS_URL,
  EONET_SOURCES_URL,
  normalizeEonet,
  parseEonetSources,
  runEonet,
  sanitizeEonetEvent,
  type EonetPolygon,
} from "../../src/ingest/sources/eonet.ts";
import type { FetchImpl } from "../../src/ingest/types.ts";
import { sha256Hex } from "../../src/lib/digest.ts";

// The fixtures are trimmed from real responses fetched at this time (2026-09-24 02:05 UTC).
const NOW = Date.parse("2026-09-24T02:05:56Z");
const HOUR = 3_600_000;
const CADENCE_MS = 1_800_000;

type RawGeometry = Record<string, unknown>;
interface RawEvent {
  id: string;
  title: string;
  closed: string | null;
  categories: { id: string; title: string }[];
  sources: { id: string; url: string }[];
  geometry: RawGeometry[];
  [key: string]: unknown;
}
interface RawResponse {
  title: string;
  events: RawEvent[];
  [key: string]: unknown;
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/eonet/${name}`, import.meta.url), "utf8"));
}

/** A fresh deep copy of the events fixture, safe to mutate. */
function sample(): RawResponse {
  return fixture("events_sample.json") as RawResponse;
}

function event(id: string, from: RawResponse = sample()): RawEvent {
  const ev = from.events.find((e) => e.id === id);
  if (!ev) throw new Error(`fixture has no ${id}`);
  return ev;
}

function record(records: EventRecord[], id: string): EventRecord {
  const r = records.find((x) => x.recordKey === `eonet:${id}`);
  if (!r) throw new Error(`no record for ${id}`);
  return r;
}

const SOURCES = parseEonetSources(fixture("sources_sample.json"));

async function freshDb(): Promise<Db> {
  const db = await openDb(":memory:");
  await migrate(db);
  return db;
}

interface FakeReply {
  status?: number;
  body?: unknown;
  error?: Error;
}

/** A fetch that answers the sources and events URLs and records every call. */
function fakeFetch(
  replies: { sources?: FakeReply; events?: FakeReply },
  calls: { url: string; userAgent: string | null }[],
): FetchImpl {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, userAgent: new Headers(init?.headers).get("user-agent") });
    const reply =
      url === EONET_SOURCES_URL
        ? (replies.sources ?? { body: fixture("sources_sample.json") })
        : (replies.events ?? { body: sample() });
    if (reply.error) throw reply.error;
    const body = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    // EONET labels its JSON as RSS; the adapter must not trust the Content-Type.
    return new Response(body, {
      status: reply.status ?? 200,
      headers: { "content-type": "application/rss+xml; charset=utf-8" },
    });
  }) as FetchImpl;
}

test("GDACS flood polygons are swapped from [lat, lon] to [lon, lat]", () => {
  const korea = sanitizeEonetEvent(event("EONET_23691"), NOW);
  const koreaPolygon = korea?.geometry[0] as EonetPolygon;
  expect(koreaPolygon.type).toBe("Polygon");
  // Upstream wrote [35.3015591, 126.5750861]: latitude first, which is off Earth as [lon, lat].
  expect(koreaPolygon.coordinates[0]?.[0]).toEqual([126.5750861, 35.3015591]);
  expect(koreaPolygon.coordinates[0]).toHaveLength(11);

  // Tunisia's swap is not detectable from the ranges alone, and is applied all the same.
  const tunisia = sanitizeEonetEvent(event("EONET_24675"), NOW);
  const tunisiaPolygon = tunisia?.geometry[0] as EonetPolygon;
  expect(tunisiaPolygon.coordinates[0]?.[0]).toEqual([8.4051824, 34.3373983]);

  // Polygons from other sources are already [lon, lat] and stay as they are.
  const other = event("EONET_23691");
  other.sources = [{ id: "EO", url: "https://earthobservatory.nasa.gov/" }];
  const ring = (other.geometry[0]?.coordinates as number[][][])[0] ?? [];
  other.geometry[0] = { ...other.geometry[0], coordinates: [ring.map(([a, b]) => [b, a])] };
  const kept = sanitizeEonetEvent(other, NOW)?.geometry[0] as EonetPolygon;
  expect(kept.coordinates[0]?.[0]).toEqual([126.5750861, 35.3015591]);
});

test("a GDACS ring that is still off Earth after the swap is rejected", () => {
  // Already [lon, lat] upstream: the swap turns 126.57 into a latitude, so the ring is rejected.
  const fixed = event("EONET_23691");
  const ring = (fixed.geometry[0]?.coordinates as number[][][])[0] ?? [];
  const lonFirst = { ...fixed.geometry[0], coordinates: [ring.map(([a, b]) => [b, a])] };
  fixed.geometry = [lonFirst];
  expect(sanitizeEonetEvent(fixed, NOW)).toBeNull();

  // With a valid point next to it, only the bad polygon goes.
  fixed.geometry = [
    lonFirst,
    {
      magnitudeValue: null,
      magnitudeUnit: null,
      date: "2026-08-29T00:00:00Z",
      type: "Point",
      coordinates: [126.5, 35.3],
    },
  ];
  const s = sanitizeEonetEvent(fixed, NOW);
  expect(s?.geometry.map((g) => g.type)).toEqual(["Point"]);

  // A polygon whose outer ring is rejected is dropped even when a hole survives.
  const holed = event("EONET_23691");
  const good = (holed.geometry[0]?.coordinates as number[][][])[0] ?? [];
  holed.geometry = [{ ...holed.geometry[0], coordinates: [good.map(([a, b]) => [b, a]), good] }];
  expect(sanitizeEonetEvent(holed, NOW)).toBeNull();
});

test("geometries dated more than 1 hour after the fetch are dropped", () => {
  const polo = event("EONET_24721");
  const base = normalizeEonet({ events: [polo] }, SOURCES, NOW, "f1", NOW)[0];

  // Synthetic future-dated geometry, like the measured Thailand flood dated 2026-10-04.
  const future = structuredClone(polo);
  future.geometry.push({
    magnitudeValue: 200,
    magnitudeUnit: "kts",
    date: new Date(NOW + 2 * HOUR).toISOString(),
    type: "Point",
    coordinates: [-103, 16],
  });
  expect(sanitizeEonetEvent(future, NOW)?.geometry).toHaveLength(12);
  const [withFuture] = normalizeEonet({ events: [future] }, SOURCES, NOW, "f1", NOW);
  // Same content after sanitation, so the same version; the raw record still holds all 13.
  expect(withFuture?.id).toBe(base?.id);
  expect(withFuture?.occurredAt).toBe(Date.parse("2026-09-23T18:00:00Z"));
  expect(withFuture?.facts.magnitude?.text).toBe("125");
  expect(withFuture?.meta?.geometry_count).toBe(12);

  // Exactly 1 hour ahead is still inside the tolerance.
  const edge = structuredClone(polo);
  edge.geometry.push({
    ...(future.geometry[12] as RawGeometry),
    date: new Date(NOW + HOUR).toISOString(),
  });
  expect(sanitizeEonetEvent(edge, NOW)?.geometry).toHaveLength(13);

  // Once the clock passes the date, the geometry is kept and makes a new version.
  const [later] = normalizeEonet(
    { events: [future] },
    SOURCES,
    NOW + 3 * HOUR,
    "f2",
    NOW + 3 * HOUR,
  );
  expect(later?.id).not.toBe(base?.id);
  expect(later?.facts.magnitude?.text).toBe("200");

  // An event whose only geometry is in the future has nothing left and is dropped.
  const onlyFuture = event("EONET_24098");
  onlyFuture.geometry = [{ ...onlyFuture.geometry[0], date: "2026-10-04T20:00:00Z" }];
  expect(sanitizeEonetEvent(onlyFuture, NOW)).toBeNull();
  expect(normalizeEonet({ events: [onlyFuture] }, SOURCES, NOW, "f1", NOW)).toEqual([]);
});

test("malformed events and geometries are rejected", () => {
  const ok = event("EONET_24098");
  expect(sanitizeEonetEvent(ok, NOW)).not.toBeNull();
  expect(sanitizeEonetEvent(null, NOW)).toBeNull();
  expect(sanitizeEonetEvent("EONET_24098", NOW)).toBeNull();
  expect(sanitizeEonetEvent({ ...ok, title: "" }, NOW)).toBeNull();
  expect(sanitizeEonetEvent({ ...ok, id: 24098 }, NOW)).toBeNull();
  // "@" separates the native id from the version, so it may not appear in the id.
  expect(sanitizeEonetEvent({ ...ok, id: "EONET@1" }, NOW)).toBeNull();
  expect(sanitizeEonetEvent({ ...ok, geometry: null }, NOW)).toBeNull();

  const point = ok.geometry[0] as RawGeometry;
  const bad: RawGeometry[] = [
    { ...point, coordinates: [200, 35] },
    { ...point, coordinates: [-103, 95] },
    { ...point, coordinates: ["-103", 35] },
    { ...point, coordinates: [-103] },
    { ...point, date: "not a date" },
    { ...point, date: null },
    { ...point, type: "LineString" },
    {
      ...point,
      type: "Polygon",
      coordinates: [
        [
          [-103, 35],
          [-104, 36],
        ],
      ],
    },
  ];
  for (const g of bad) expect(sanitizeEonetEvent({ ...ok, geometry: [g] }, NOW)).toBeNull();
  // One good geometry is enough to keep the event.
  expect(sanitizeEonetEvent({ ...ok, geometry: [...bad, point] }, NOW)?.geometry).toHaveLength(1);
});

test("the fixture normalizes to one version per event with upstream facts", () => {
  const response = sample();
  const records = normalizeEonet(response, SOURCES, NOW, "eonet@fixture", NOW);
  expect(records).toHaveLength(5);
  for (const r of records) {
    expect(r.id).toMatch(/^eonet:EONET_\d+@[0-9a-f]{12}$/);
    expect(r.id.startsWith(`${r.recordKey}@`)).toBe(true);
    expect(r.source).toBe("eonet");
    expect(r.kind).toBe("natural_event");
    expect(r.fetchedAt).toBe(NOW);
    expect(r.fetchId).toBe("eonet@fixture");
    expect(r.supersedes).toBeNull();
    expect(r.rawGz).toBeNull();
    expect(r.raw).toBe(JSON.stringify(event(r.recordKey.slice("eonet:".length), response)));
    expect(r.rawDigest).toBe(sha256Hex(r.raw ?? ""));
    for (const fact of Object.values(r.facts)) expect(typeof fact.text).toBe("string");
  }

  // A severe storm with magnitudes and two upstream sources: facts come from the newest fix.
  const polo = record(records, "EONET_24721");
  expect(polo.title).toBe("Hurricane Polo");
  expect(polo.occurredAt).toBe(Date.parse("2026-09-23T18:00:00Z"));
  expect(polo.sourceUpdatedAt).toBe(polo.occurredAt);
  expect([polo.lon, polo.lat]).toEqual([-102.1, 15.5]);
  expect(polo.bbox).toBeNull();
  expect(polo.facts).toEqual({
    title: { value: "Hurricane Polo", text: "Hurricane Polo" },
    category: { value: "Severe Storms", text: "Severe Storms" },
    source: {
      value: "Joint Typhoon Warning Center, National Hurricane Center",
      text: "Joint Typhoon Warning Center, National Hurricane Center",
    },
    date: { value: Date.parse("2026-09-23T18:00:00Z"), text: "2026-09-23" },
    magnitude: { value: 125, text: "125", unit: "kts" },
    magnitude_unit: { value: "kts", text: "kts" },
  });
  expect(polo.meta).toEqual({
    categories: [{ id: "severeStorms", title: "Severe Storms" }],
    sources: [
      { id: "JTWC", url: "https://www.metoc.navy.mil/jtwc/products/ep1726.tcw" },
      { id: "NOAA_NHC", url: "https://www.nhc.noaa.gov/archive/2026/POLO.shtml" },
    ],
    closed: null,
    geometry_count: 12,
  });

  // A GDACS flood polygon: centroid and bbox in [lon, lat] after the swap, no magnitude facts.
  const korea = record(records, "EONET_23691");
  expect(korea.bbox).toEqual({
    minLat: 35.300398,
    minLon: 126.5750861,
    maxLat: 35.3015591,
    maxLon: 126.5768486,
  });
  const { bbox } = korea;
  expect(korea.lat).toBeGreaterThan(bbox?.minLat ?? Infinity);
  expect(korea.lat).toBeLessThan(bbox?.maxLat ?? -Infinity);
  expect(korea.lon).toBeGreaterThan(bbox?.minLon ?? Infinity);
  expect(korea.lon).toBeLessThan(bbox?.maxLon ?? -Infinity);
  expect(korea.facts.source?.text).toBe("Global Disaster Alert and Coordination System");
  expect(korea.facts.title?.text).toBe("Flood in South Korea 1104133");
  expect(korea.facts.date?.text).toBe("2026-08-28");
  expect(korea.facts.magnitude).toBeUndefined();
  expect(korea.facts.magnitude_unit).toBeUndefined();
  expect(korea.meta?.closed).toBe("2026-08-30T00:00:00Z");

  const fire = record(records, "EONET_24098");
  expect(fire.facts.magnitude).toEqual({ value: 822, text: "822", unit: "acres" });
  expect(fire.facts.source?.text).toBe(
    "Integrated Reporting of Wildfire Information (IRWIN) Observer",
  );
  expect(record(records, "EONET_23286").meta?.closed).toBe("2026-08-30T00:00:00Z");
});

test("version ids depend on sanitized content only", () => {
  const a = normalizeEonet(sample(), SOURCES, NOW, "f1", NOW);
  // Another fetch time, fetch id, and missing source titles: same content, same versions.
  const b = normalizeEonet(sample(), new Map(), NOW + 30 * HOUR, "f2", NOW + 30 * HOUR);
  expect(b.map((r) => r.id)).toEqual(a.map((r) => r.id));
  // Without a title from /sources, the source fact falls back to the upstream id.
  expect(record(b, "EONET_24721").facts.source?.text).toBe("JTWC, NOAA_NHC");

  // Geometry order is canonical, so a reordered array is not a new version.
  const shuffled = sample();
  event("EONET_24721", shuffled).geometry.reverse();
  expect(normalizeEonet(shuffled, SOURCES, NOW, "f1", NOW).map((r) => r.id)).toEqual(
    a.map((r) => r.id),
  );

  // A revised magnitude on one event changes that event's version and nothing else.
  const revised = sample();
  const last = event("EONET_24721", revised).geometry.at(-1) as RawGeometry;
  last.magnitudeValue = 120;
  const c = normalizeEonet(revised, SOURCES, NOW, "f1", NOW);
  for (const r of c) {
    const before = record(a, r.recordKey.slice("eonet:".length));
    if (r.recordKey === "eonet:EONET_24721") expect(r.id).not.toBe(before.id);
    else expect(r.id).toBe(before.id);
  }

  // The same event twice in one response yields one record.
  const doubled = sample();
  doubled.events.push(structuredClone(event("EONET_24098", doubled)));
  expect(normalizeEonet(doubled, SOURCES, NOW, "f1", NOW)).toHaveLength(5);
});

test("responses of the wrong shape are rejected", () => {
  expect(() => normalizeEonet({ title: "EONET Events" }, SOURCES, NOW, "f", NOW)).toThrow(/events/);
  expect(() => normalizeEonet(null, SOURCES, NOW, "f", NOW)).toThrow(/events/);
  expect(() => parseEonetSources({ title: "EONET Sources" })).toThrow(/sources/);
  expect(SOURCES.get("GDACS")).toEqual({
    title: "Global Disaster Alert and Coordination System",
    url: "http://www.gdacs.org/",
  });
  expect([...SOURCES.keys()].sort()).toEqual(["GDACS", "IRWIN", "JTWC", "NOAA_NHC"]);
});

test("runEonet stores new versions once and links revisions", async () => {
  const db = await freshDb();
  const calls: { url: string; userAgent: string | null }[] = [];

  const first = await runEonet(db, { now: NOW, fetchImpl: fakeFetch({}, calls) });
  expect(first).toMatchObject({ source: "eonet", fetched: 5, inserted: 5, status: "ok" });
  // Titles from /sources once, then the events feed, both with the contact User-Agent.
  expect(calls.map((c) => c.url)).toEqual([
    "https://eonet.gsfc.nasa.gov/api/v3/sources",
    "https://eonet.gsfc.nasa.gov/api/v3/events?status=all&days=3",
  ]);
  expect(EONET_EVENTS_URL).toBe(calls[1]?.url);
  for (const c of calls) expect(c.userAgent).toBe("Argus/0.1 (+https://github.com/n8v1ct0r)");

  const stored = await listEvents(db, { kinds: ["natural_event"] });
  expect(stored).toHaveLength(5);
  const expected = normalizeEonet(
    sample(),
    SOURCES,
    NOW,
    `eonet@${new Date(NOW).toISOString()}`,
    NOW,
  );
  const [roundTrip] = await getEvents(db, [record(expected, "EONET_23691").id]);
  expect(roundTrip).toEqual(record(expected, "EONET_23691"));

  const log = await db.execute(
    "SELECT requests, last_status FROM fetch_log WHERE source = 'eonet'",
  );
  expect(log.rows[0]).toMatchObject({ requests: 2, last_status: 200 });

  // Unchanged upstream data writes nothing.
  const again = await runEonet(db, { now: NOW + CADENCE_MS, fetchImpl: fakeFetch({}, []) });
  expect(again).toMatchObject({ fetched: 5, inserted: 0, status: "ok" });

  // A new fix on one storm is a new version that supersedes the previous one.
  const firstPolo = await latestVersion(db, "eonet:EONET_24721");
  const revised = sample();
  event("EONET_24721", revised).geometry.push({
    magnitudeValue: 115,
    magnitudeUnit: "kts",
    date: "2026-09-24T00:00:00Z",
    type: "Point",
    coordinates: [-102.8, 15.9],
  });
  const third = await runEonet(db, {
    now: NOW + 2 * CADENCE_MS,
    fetchImpl: fakeFetch({ events: { body: revised } }, []),
  });
  expect(third).toMatchObject({ fetched: 5, inserted: 1, status: "ok" });
  const newPolo = await latestVersion(db, "eonet:EONET_24721");
  expect(newPolo?.id).not.toBe(firstPolo?.id);
  expect(newPolo?.supersedes).toBe(firstPolo?.id);
  expect(newPolo?.facts.magnitude?.text).toBe("115");
  expect(newPolo?.facts.date?.text).toBe("2026-09-24");
  // The earlier version is immutable and still readable.
  const [oldPolo] = await getEvents(db, [firstPolo?.id ?? ""]);
  expect(oldPolo?.facts.magnitude?.text).toBe("125");
  expect(await listEvents(db, { kinds: ["natural_event"] })).toHaveLength(6);
});

test("runEonet backs off after an upstream failure", async () => {
  const db = await freshDb();

  // Sources down: stop before the events request and schedule a backoff.
  const calls: { url: string; userAgent: string | null }[] = [];
  const down = await runEonet(db, {
    now: NOW,
    fetchImpl: fakeFetch({ sources: { status: 503, body: "busy" } }, calls),
  });
  expect(down).toMatchObject({ status: "error", fetched: 0, inserted: 0 });
  expect(calls.map((c) => c.url)).toEqual([EONET_SOURCES_URL]);
  expect(await getBackoff(db, "eonet")).toEqual({
    failures: 1,
    nextAllowedAt: NOW + CADENCE_MS,
    lastStatus: 503,
  });

  // Inside the backoff window nothing is requested.
  const skippedCalls: { url: string; userAgent: string | null }[] = [];
  const skipped = await runEonet(db, {
    now: NOW + 60_000,
    fetchImpl: fakeFetch({}, skippedCalls),
  });
  expect(skipped.status).toBe("skipped_backoff");
  expect(skippedCalls).toHaveLength(0);

  // A body that is not JSON is an error too, logged with the reason; the backoff doubles.
  const garbled = await runEonet(db, {
    now: NOW + CADENCE_MS,
    fetchImpl: fakeFetch({ events: { body: "<rss>not json</rss>" } }, []),
  });
  expect(garbled.status).toBe("error");
  expect((await getBackoff(db, "eonet"))?.nextAllowedAt).toBe(NOW + CADENCE_MS + 2 * CADENCE_MS);
  const errors = await db.execute("SELECT url, status, message FROM fetch_errors ORDER BY id");
  expect(errors.rows.map((r) => [r.url, r.status])).toEqual([
    [EONET_SOURCES_URL, 503],
    [EONET_EVENTS_URL, 200],
  ]);
  expect(String(errors.rows[1]?.message)).toContain("Unreadable JSON");

  // A network error counts the same way.
  const offline = await runEonet(db, {
    now: NOW + 3 * CADENCE_MS,
    fetchImpl: fakeFetch({ sources: { error: new TypeError("fetch failed") } }, []),
  });
  expect(offline.status).toBe("error");
  expect((await getBackoff(db, "eonet"))?.failures).toBe(3);

  // The first success after the window clears the backoff.
  const back = await runEonet(db, { now: NOW + 7 * CADENCE_MS, fetchImpl: fakeFetch({}, []) });
  expect(back).toMatchObject({ status: "ok", inserted: 5 });
  expect(await getBackoff(db, "eonet")).toBeNull();
});
