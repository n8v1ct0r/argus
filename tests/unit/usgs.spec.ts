import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { config } from "../../argus.config.ts";
import { migrate, openDb, type Db } from "../../src/db/client.ts";
import { getEvents, latestVersion, listEvents } from "../../src/db/queries.ts";
import type { EventRecord } from "../../src/events/types.ts";
import {
  FDSN_LOG_SOURCE,
  MAX_FDSN_CHECKS_PER_RUN,
  normalizeUsgsFeed,
  runUsgs,
} from "../../src/ingest/sources/usgs.ts";
import type { FetchImpl } from "../../src/ingest/types.ts";
import { sha256Hex } from "../../src/lib/digest.ts";

// Fixtures. all_day_sample.json is a real all_day.geojson response (captured 2026-09-24 02:08 UTC)
// trimmed to 6 features, each byte-identical to the feed: a quarry blast, a negative depth, two
// merged-id events, and two larger quakes. all_day_revision.json is derived from it 10 minutes
// later: us6000tx29 revised (new updated, mag 5.3 to 5.4) and nc75440422's preferred id changed
// to nn00924795, which was already in its ids list. See tests/fixtures/usgs/README.md.

interface Feature {
  type: "Feature";
  id: string;
  properties: Record<string, unknown> & { ids: string; time: number; updated: number };
  geometry: { type: "Point"; coordinates: number[] };
}
interface Feed {
  type: "FeatureCollection";
  metadata: Record<string, unknown> & { generated: number };
  features: Feature[];
}

const fixtureUrl = (name: string) => new URL(`../fixtures/usgs/${name}`, import.meta.url);
const fixtureText = (name: string) => readFileSync(fixtureUrl(name), "utf8");
const fixture = (name: string): Feed => JSON.parse(fixtureText(name)) as Feed;

const GENERATED = 1_790_215_716_000; // metadata.generated of the sample
const T0 = GENERATED + 30_000;
const MIN = 60_000;

// The FDSN event service's real answer for a deleted event (nn00924808, 2026-09-24).
const DELETED_BODY = fixtureText("fdsn_deleted_409.txt");

async function freshDb(): Promise<Db> {
  const db = await openDb(":memory:");
  await migrate(db);
  return db;
}

function without(feed: Feed, ...ids: string[]): Feed {
  return { ...feed, features: feed.features.filter((f) => !ids.includes(f.id)) };
}

/** A fetch double: the feed URL serves `feed()`, FDSN URLs go to `fdsn(eventId)`. */
function fakeFetch(
  feed: () => Feed | Response,
  fdsn: (eventId: string) => Response = () => new Response("unexpected", { status: 500 }),
) {
  const calls: { url: string; userAgent: string | null }[] = [];
  const fdsnIds: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, userAgent: new Headers(init?.headers).get("user-agent") });
    if (url === config.sources.usgs.url) {
      const body = feed();
      return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
    }
    if (url.startsWith(config.sources.usgs.fdsnUrl)) {
      const id = new URL(url).searchParams.get("eventid") ?? "";
      fdsnIds.push(id);
      return fdsn(id);
    }
    return new Response("unknown url", { status: 500 });
  }) as FetchImpl;
  return { fetchImpl, calls, fdsnIds };
}

const textsOf = (e: EventRecord | undefined) =>
  Object.fromEntries(Object.entries(e?.facts ?? {}).map(([k, f]) => [k, f.text]));

async function one(db: Db, id: string): Promise<EventRecord> {
  const [e] = await getEvents(db, [id]);
  if (!e) throw new Error(`missing event ${id}`);
  return e;
}

async function fetchErrors(db: Db) {
  const rs = await db.execute("SELECT source, url, status FROM fetch_errors ORDER BY id");
  return rs.rows.map((r) => ({ source: String(r.source), url: String(r.url), status: r.status }));
}

test("normalizes the sample into one version per feature with exact fact strings", () => {
  const sample = fixture("all_day_sample.json");
  const records = normalizeUsgsFeed(sample, T0, "fetch:test");
  expect(records.map((e) => e.id)).toEqual([
    "usgs:ci41337919@1790192764590",
    "usgs:ci41337911@1790194385043",
    "usgs:nc75440422@1790191342331",
    "usgs:us6000tx3m@1790182251242",
    "usgs:hv75042652@1790196762210",
    "usgs:us6000tx29@1790178858908",
  ]);
  for (const e of records) {
    expect(e.recordKey).toBe(e.id.slice(0, e.id.indexOf("@")));
    expect([e.source, e.kind, e.fetchedAt, e.fetchId, e.supersedes]).toEqual([
      "usgs",
      "earthquake",
      T0,
      "fetch:test",
      null,
    ]);
    // Only these are citable; ids, sources, net, code, tsunami, sig, url, felt stay in meta.
    expect(Object.keys(e.facts).sort()).toEqual(
      ["date", "depth_km", "mag", "mag_type", "place", "status", "time", "type"].sort(),
    );
  }
  const [negDepth, blast, mergedIds, tonga, hawaii] = records;

  expect(textsOf(negDepth)).toEqual({
    mag: "0.9",
    mag_type: "ml",
    depth_km: "-0.8",
    place: "3 km SE of Lake Henshaw, CA",
    time: "19:42 UTC",
    date: "2026-09-23",
    status: "automatic",
    type: "earthquake",
  });
  expect(negDepth?.facts.depth_km).toEqual({ value: -0.8, text: "-0.8", unit: "km" });
  expect(negDepth?.title).toBe("M 0.9, 3 km SE of Lake Henshaw, CA");
  expect([negDepth?.lat, negDepth?.lon]).toEqual([33.2258333333333, -116.7425]);
  expect([negDepth?.occurredAt, negDepth?.sourceUpdatedAt]).toEqual([
    1_790_192_561_160, 1_790_192_764_590,
  ]);

  expect(textsOf(blast)).toMatchObject({
    type: "quarry blast",
    mag: "1.18",
    depth_km: "-0.91",
    status: "reviewed",
    time: "19:37 UTC",
  });
  expect(blast?.title).toBe("M 1.18, 5 km NE of Bradbury, CA");

  expect(mergedIds?.meta?.ids).toEqual(["nc75440422", "nn00924795"]);
  expect(mergedIds?.meta?.sources).toEqual(["nc", "nn"]);
  expect(mergedIds?.facts.depth_km?.text).toBe("2.97000002861023");
  expect(mergedIds?.facts.mag_type?.text).toBe("md");

  expect(tonga?.title).toBe("M 5.7, 180 km NW of Hihifo, Tonga");
  expect(tonga?.meta).toMatchObject({
    net: "us",
    code: "6000tx3m",
    tsunami: 0,
    alert: "green",
    felt: null,
    url: "https://earthquake.usgs.gov/earthquakes/eventpage/us6000tx3m",
  });
  expect(textsOf(tonga)).toMatchObject({ mag: "5.7", mag_type: "mww", depth_km: "10" });

  expect(hawaii?.facts.place?.text).toBe("4 km S of Pāhala, Hawaii");
  expect(hawaii?.meta?.ids).toEqual(["us6000tx3b", "hv75042652"]);
});

test("raw is the feature as received and rawDigest is its SHA-256", () => {
  const text = fixtureText("all_day_sample.json");
  const sample = JSON.parse(text) as Feed;
  const records = normalizeUsgsFeed(sample, T0, "fetch:test");
  records.forEach((e, i) => {
    expect(e.raw).toBe(JSON.stringify(sample.features[i]));
    expect(text.includes(e.raw ?? "\u0000")).toBe(true); // byte-identical to the response
    expect(e.rawDigest).toBe(sha256Hex(e.raw ?? ""));
    expect(e.rawGz).toBeNull();
  });
});

test("rejects a non-collection and skips malformed features", () => {
  expect(() => normalizeUsgsFeed({}, T0, "f")).toThrow("not a GeoJSON FeatureCollection");
  expect(() => normalizeUsgsFeed({ type: "Feature" }, T0, "f")).toThrow();
  const broken = fixture("all_day_sample.json");
  const [noUpdated, noGeometry] = broken.features;
  if (!noUpdated || !noGeometry) throw new Error("fixture changed");
  delete (noUpdated.properties as Record<string, unknown>).updated;
  (noGeometry as unknown as { geometry: unknown }).geometry = null;
  expect(normalizeUsgsFeed(broken, T0, "f")).toHaveLength(4);
});

test("a null magnitude or place leaves that fact out and the title says so", () => {
  const feed = fixture("all_day_sample.json");
  const [noPlace, noMag] = feed.features;
  if (!noPlace || !noMag) throw new Error("fixture changed");
  noPlace.properties.place = null; // deleted events come back from FDSN like this
  noMag.properties.mag = null;
  noMag.properties.magType = null;
  const [a, b] = normalizeUsgsFeed(feed, T0, "f");
  expect(a?.title).toBe("M 0.9");
  expect(a?.facts.place).toBeUndefined();
  expect(b?.title).toBe("Magnitude not given, 5 km NE of Bradbury, CA");
  expect(Object.keys(b?.facts ?? {})).not.toContain("mag");
  expect(Object.keys(b?.facts ?? {})).not.toContain("mag_type");
});

test("runUsgs stores the feed once, waits 60 s between fetches, and re-ingest is idempotent", async () => {
  const db = await freshDb();
  const sample = fixture("all_day_sample.json");
  const net = fakeFetch(() => sample);

  const first = await runUsgs(db, { now: T0, fetchImpl: net.fetchImpl });
  expect(first).toMatchObject({ source: "usgs", status: "ok", fetched: 6, inserted: 6 });
  expect(net.calls).toEqual([
    { url: config.sources.usgs.url, userAgent: "Argus/0.1 (+https://github.com/n8v1ct0r)" },
  ]);
  const stored = await one(db, "usgs:ci41337919@1790192764590");
  expect(stored.fetchId).toBe(`fetch:usgs:${T0}`);
  expect(stored.recordKey).toBe("usgs:ci41337919");

  const early = await runUsgs(db, { now: T0 + 30_000, fetchImpl: net.fetchImpl });
  expect(early).toMatchObject({ status: "not_modified", fetched: 0, inserted: 0 });
  expect(net.calls).toHaveLength(1);

  const again = await runUsgs(db, { now: T0 + MIN, fetchImpl: net.fetchImpl });
  expect(again).toMatchObject({ status: "ok", fetched: 6, inserted: 0 });
  expect(net.calls).toHaveLength(2);
  expect(net.fdsnIds).toEqual([]);
  expect(await listEvents(db, { kinds: ["earthquake"] })).toHaveLength(6);
});

test("a revision and a preferred id change become new versions of the same records", async () => {
  const db = await freshDb();
  const sample = fixture("all_day_sample.json");
  const revision = fixture("all_day_revision.json");
  let feed = sample;
  const net = fakeFetch(() => feed);

  await runUsgs(db, { now: T0, fetchImpl: net.fetchImpl });
  feed = revision;
  const rev = await runUsgs(db, { now: T0 + 10 * MIN, fetchImpl: net.fetchImpl });
  expect(rev).toMatchObject({ status: "ok", fetched: 6, inserted: 2 });
  expect(net.fdsnIds).toEqual([]);

  const revised = await one(db, "usgs:us6000tx29@1790216016000");
  expect(revised.recordKey).toBe("usgs:us6000tx29");
  expect(revised.supersedes).toBe("usgs:us6000tx29@1790178858908");
  expect(revised.facts.mag?.text).toBe("5.4");
  expect(revised.title).toBe("M 5.4, 51 km WSW of Arauco, Argentina");
  // The earlier version is untouched.
  expect((await one(db, "usgs:us6000tx29@1790178858908")).facts.mag?.text).toBe("5.3");

  // nn00924795 is now preferred, but nc75440422 is in its ids and already a record key.
  const renamed = await one(db, "usgs:nn00924795@1790216076000");
  expect(renamed.recordKey).toBe("usgs:nc75440422");
  expect(renamed.supersedes).toBe("usgs:nc75440422@1790191342331");
  expect(textsOf(renamed)).toMatchObject({ mag: "2.6", mag_type: "ml" });
  expect(renamed.meta?.ids).toEqual(["nn00924795", "nc75440422"]);
  expect((await latestVersion(db, "usgs:nc75440422"))?.id).toBe("usgs:nn00924795@1790216076000");
  expect(await latestVersion(db, "usgs:nn00924795")).toBeNull();

  // Re-ingesting the revision writes nothing; neither does a lagging cache serving the old feed.
  expect(await runUsgs(db, { now: T0 + 11 * MIN, fetchImpl: net.fetchImpl })).toMatchObject({
    inserted: 0,
  });
  feed = sample;
  const lagging = await runUsgs(db, { now: T0 + 12 * MIN, fetchImpl: net.fetchImpl });
  expect(lagging).toMatchObject({ status: "ok", inserted: 0 });
  expect(lagging.message).toContain("2 stale skipped");
  expect((await latestVersion(db, "usgs:nc75440422"))?.id).toBe("usgs:nn00924795@1790216076000");
  expect(await listEvents(db, { kinds: ["earthquake"] })).toHaveLength(8);
  expect(net.fdsnIds).toEqual([]);
});

test("a vanished record is checked against FDSN; 409 writes a tombstone, 200 waits an hour", async () => {
  const db = await freshDb();
  const sample = fixture("all_day_sample.json");
  let feed = sample;
  const net = fakeFetch(
    () => feed,
    (id) =>
      id === "ci41337919"
        ? new Response(DELETED_BODY, { status: 409 })
        : new Response('{"type":"Feature"}', { status: 200 }),
  );
  await runUsgs(db, { now: T0, fetchImpl: net.fetchImpl });

  feed = without(sample, "ci41337919", "us6000tx29");
  const t1 = T0 + 5 * MIN;
  const run = await runUsgs(db, { now: t1, fetchImpl: net.fetchImpl });
  expect(run).toMatchObject({ status: "ok", fetched: 4, inserted: 1 });
  expect(net.fdsnIds).toEqual(["ci41337919", "us6000tx29"]); // newest first
  expect(net.calls.at(-2)?.url).toBe(
    "https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=ci41337919&format=geojson",
  );
  expect(net.calls.at(-2)?.userAgent).toBe(config.userAgent);

  const tombId = `usgs:ci41337919@deleted-${t1}`;
  const tomb = await one(db, tombId);
  expect(tomb.recordKey).toBe("usgs:ci41337919");
  expect(tomb.supersedes).toBe("usgs:ci41337919@1790192764590");
  expect(tomb.facts.status).toEqual({ value: "deleted", text: "deleted" });
  expect(tomb.meta?.deleted).toBe(true);
  expect(tomb.raw).toBe(DELETED_BODY);
  expect(tomb.rawDigest).toBe(sha256Hex(DELETED_BODY));
  expect(tomb.title).toBe("Deleted: M 0.9, 3 km SE of Lake Henshaw, CA");
  expect([tomb.fetchedAt, tomb.occurredAt]).toEqual([t1, 1_790_192_561_160]);
  expect((await latestVersion(db, "usgs:ci41337919"))?.id).toBe(tombId);
  // A 200 means the event still exists: no tombstone.
  expect((await latestVersion(db, "usgs:us6000tx29"))?.id).toBe("usgs:us6000tx29@1790178858908");

  // Both checks are logged under the FDSN source, never as feed errors.
  const errors = await fetchErrors(db);
  expect(errors.map((e) => [e.source, e.status])).toEqual([
    [FDSN_LOG_SOURCE, 409],
    [FDSN_LOG_SOURCE, 200],
  ]);

  // Within the hour: the tombstoned record is done and the live one is not asked again.
  expect(await runUsgs(db, { now: t1 + 5 * MIN, fetchImpl: net.fetchImpl })).toMatchObject({
    inserted: 0,
  });
  expect(net.fdsnIds).toHaveLength(2);
  // After an hour the still-missing live record is checked once more.
  await runUsgs(db, { now: t1 + 61 * MIN, fetchImpl: net.fetchImpl });
  expect(net.fdsnIds).toEqual(["ci41337919", "us6000tx29", "us6000tx29"]);
});

test("a tombstoned event that returns unchanged gets a restored version", async () => {
  const db = await freshDb();
  const sample = fixture("all_day_sample.json");
  let feed = sample;
  const net = fakeFetch(
    () => feed,
    () => new Response(DELETED_BODY, { status: 409 }),
  );
  await runUsgs(db, { now: T0, fetchImpl: net.fetchImpl });
  feed = without(sample, "ci41337919");
  await runUsgs(db, { now: T0 + 5 * MIN, fetchImpl: net.fetchImpl });
  feed = sample;
  const t2 = T0 + 10 * MIN;
  expect(await runUsgs(db, { now: t2, fetchImpl: net.fetchImpl })).toMatchObject({ inserted: 1 });
  const restored = await latestVersion(db, "usgs:ci41337919");
  expect(restored?.id).toBe(`usgs:ci41337919@1790192764590-restored-${t2}`);
  expect(restored?.supersedes).toBe(`usgs:ci41337919@deleted-${T0 + 5 * MIN}`);
  expect(restored?.facts.status?.text).toBe("automatic");
});

test("a record whose id moved into another event is marked merged, not checked", async () => {
  const db = await freshDb();
  const sample = fixture("all_day_sample.json");
  // Before association: the nn solution was a separate event (synthetic, built from the real one).
  const split = structuredClone(sample);
  const nc = split.features.find((f) => f.id === "nc75440422");
  if (!nc) throw new Error("fixture changed");
  nc.properties.ids = ",nc75440422,";
  const nn = structuredClone(nc);
  nn.id = "nn00924795";
  Object.assign(nn.properties, {
    ids: ",nn00924795,",
    net: "nn",
    code: "00924795",
    mag: 2.6,
    magType: "ml",
    updated: nc.properties.updated - MIN,
  });
  split.features.push(nn);

  let feed = split;
  const net = fakeFetch(() => feed);
  expect(await runUsgs(db, { now: T0, fetchImpl: net.fetchImpl })).toMatchObject({ inserted: 7 });

  feed = sample; // the real feed: nc75440422 now lists nn00924795 in its ids
  const t1 = T0 + 5 * MIN;
  const run = await runUsgs(db, { now: t1, fetchImpl: net.fetchImpl });
  // The nc record keeps its key; its ids changed but `updated` did not, so no new version.
  expect(run).toMatchObject({ status: "ok", inserted: 1 });
  expect(net.fdsnIds).toEqual([]);
  const marker = await latestVersion(db, "usgs:nn00924795");
  expect(marker?.id).toBe(`usgs:nn00924795@merged-${t1}`);
  expect(marker?.supersedes).toBe(`usgs:nn00924795@${nc.properties.updated - MIN}`);
  expect(marker?.meta).toMatchObject({ deleted: true, mergedInto: "usgs:nc75440422" });
  expect(marker?.facts.status?.text).toBe("merged");
  const realNc = sample.features.find((f) => f.id === "nc75440422");
  expect(marker?.raw).toBe(JSON.stringify(realNc));
  expect((await latestVersion(db, "usgs:nc75440422"))?.id).toBe("usgs:nc75440422@1790191342331");

  expect(await runUsgs(db, { now: t1 + 5 * MIN, fetchImpl: net.fetchImpl })).toMatchObject({
    inserted: 0,
  });
  expect(net.fdsnIds).toEqual([]);
});

test("FDSN checks stop at the per-run cap and skip records at the window edge", async () => {
  const sample = fixture("all_day_sample.json");
  const notFound = () => new Response("Error 404: Not Found", { status: 404 });

  const capped = await freshDb();
  let feed = sample;
  const a = fakeFetch(() => feed, notFound);
  await runUsgs(capped, { now: T0, fetchImpl: a.fetchImpl });
  feed = without(sample, ...sample.features.map((f) => f.id));
  const run = await runUsgs(capped, { now: T0 + 5 * MIN, fetchImpl: a.fetchImpl });
  expect(run).toMatchObject({ status: "ok", fetched: 0, inserted: 0 });
  expect(a.fdsnIds).toHaveLength(MAX_FDSN_CHECKS_PER_RUN);
  expect(a.fdsnIds).toEqual(["ci41337919", "ci41337911", "nc75440422", "us6000tx3m", "hv75042652"]);

  // A feed generated 24 h after hv75042652's origin: it and the older us6000tx29 have aged out.
  const edge = await freshDb();
  const hvTime = 1_790_170_060_550;
  feed = sample;
  const b = fakeFetch(() => feed, notFound);
  await runUsgs(edge, { now: T0, fetchImpl: b.fetchImpl });
  feed = {
    ...without(sample, ...sample.features.map((f) => f.id)),
    metadata: { ...sample.metadata, generated: hvTime + 24 * 60 * MIN },
  };
  await runUsgs(edge, { now: hvTime + 24 * 60 * MIN + 30_000, fetchImpl: b.fetchImpl });
  expect(b.fdsnIds).toEqual(["ci41337919", "ci41337911", "nc75440422", "us6000tx3m"]);
});

test("a failed feed fetch returns an error without retrying", async () => {
  const db = await freshDb();
  const down = fakeFetch(() => new Response("busy", { status: 503 }));
  const res = await runUsgs(db, { now: T0, fetchImpl: down.fetchImpl });
  expect(res).toMatchObject({ source: "usgs", status: "error", message: "HTTP 503", inserted: 0 });
  expect(down.calls).toHaveLength(1);
  expect(await listEvents(db, { kinds: ["earthquake"] })).toHaveLength(0);
  expect((await fetchErrors(db)).map((e) => [e.source, e.status])).toEqual([["usgs", 503]]);

  const garbled = fakeFetch(() => new Response("<html>", { status: 200 }));
  const bad = await runUsgs(db, { now: T0 + MIN, fetchImpl: garbled.fetchImpl });
  expect(bad.status).toBe("error");
  expect(bad.message).toContain("Unreadable feed");
  expect(garbled.calls).toHaveLength(1);
});
