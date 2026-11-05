// Seeding helpers for the read API tests. Every event is built by the merged normalizers and
// detectors from the committed fixtures of the other modules, then written through
// insertEvents and linkEvents, exactly as the ingest worker writes them.
import { readFileSync } from "node:fs";
import { config } from "../../../argus.config.ts";
import { migrate, openDb, type Db } from "../../../src/db/client.ts";
import { insertEvents, linkEvents, listEvents } from "../../../src/db/queries.ts";
import { detectQuakeClusters } from "../../../src/detectors/quake-cluster.ts";
import type { EventRecord } from "../../../src/events/types.ts";
import { normalizeEonet, parseEonetSources } from "../../../src/ingest/sources/eonet.ts";
import { groupBatches, parseFirmsCsv } from "../../../src/ingest/sources/firms.ts";
import { normalizeUsgsFeed, runUsgs } from "../../../src/ingest/sources/usgs.ts";
import type { FetchImpl } from "../../../src/ingest/types.ts";

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export async function freshDb(): Promise<Db> {
  const db = await openDb(":memory:");
  await migrate(db);
  return db;
}

function fixtureText(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

// ---------------------------------------------------------------------------------------------
// USGS

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

export const USGS_SAMPLE = JSON.parse(fixtureText("usgs/all_day_sample.json")) as Feed;
export const USGS_REVISION = JSON.parse(fixtureText("usgs/all_day_revision.json")) as Feed;
/** First ingest run: 30 s after the sample was generated. */
export const USGS_T0 = USGS_SAMPLE.metadata.generated + 30_000;
/** Second run: the revision feed, 10 minutes later. */
export const USGS_T1 = USGS_T0 + 10 * MINUTE;
/** A window that holds every quake in both feeds. */
export const USGS_WINDOW = { from: 1_790_150_000_000, to: 1_790_200_000_000 };

function feedFetch(feed: Feed): FetchImpl {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(config.sources.usgs.url)) {
      return new Response(JSON.stringify(feed), { status: 200 });
    }
    return new Response("unexpected request", { status: 500 });
  }) as FetchImpl;
}

/** Runs the USGS adapter on the sample, then on the revision (alias change and a new magnitude). */
export async function seedUsgs(db: Db): Promise<void> {
  const first = await runUsgs(db, { now: USGS_T0, fetchImpl: feedFetch(USGS_SAMPLE) });
  const second = await runUsgs(db, { now: USGS_T1, fetchImpl: feedFetch(USGS_REVISION) });
  if (first.status !== "ok" || second.status !== "ok") {
    throw new Error(`USGS seed failed: ${first.message} / ${second.message}`);
  }
}

/** A synthetic feature shaped like the feed's, for quakes the fixture does not have. */
function syntheticFeature(
  id: string,
  time: number,
  lat: number,
  lon: number,
  mag: number,
  updated = time + 5 * MINUTE,
): Feature {
  const base = USGS_SAMPLE.features[0];
  if (!base) throw new Error("USGS sample has no features");
  return {
    ...base,
    id,
    properties: {
      ...base.properties,
      mag,
      place: "10 km N of Testville, CA",
      time,
      updated,
      type: "earthquake",
      ids: `,${id},`,
      sources: ",ci,",
      code: id.slice(2),
    },
    geometry: { type: "Point", coordinates: [lon, lat, 8.1] },
  };
}

/** Anchor time of the synthetic swarm: inside USGS_WINDOW, after every fixture quake. */
export const SWARM_T = 1_790_193_000_000;
export const SWARM_IDS = ["ci90000001", "ci90000002", "ci90000003", "ci90000004"];

/** Four M2.5+ quakes within a few km in 90 minutes: one quake-cluster detection. */
export function swarmFeed(): Feed {
  return {
    ...USGS_SAMPLE,
    features: SWARM_IDS.map((id, i) =>
      syntheticFeature(id, SWARM_T + i * 30 * MINUTE, 35.7 + i * 0.01, -117.5, 2.5 + i * 0.2),
    ),
  };
}

/** Stores a feed's versions as fetched at `fetchedAt`. */
export async function storeFeed(db: Db, feed: Feed, fetchedAt: number): Promise<EventRecord[]> {
  const records = normalizeUsgsFeed(feed, fetchedAt, `fetch:usgs:${fetchedAt}`);
  await insertEvents(db, records, "ingest", fetchedAt);
  return records;
}

/** Runs the quake-cluster detector over the stored quakes and stores its detections and links. */
export async function storeClusters(db: Db): Promise<EventRecord[]> {
  const quakes = await listEvents(db, { kinds: ["earthquake"], limit: 5000 });
  const found = detectQuakeClusters(quakes);
  for (const { detection, members } of found) {
    await insertEvents(db, [detection], "ingest", detection.fetchedAt);
    await linkEvents(db, detection.id, members);
  }
  return found.map((f) => f.detection);
}

/** A newer version of a swarm quake with a revised magnitude (same record key). */
export function revisedSwarmQuake(index: number, fetchedAt: number): Feed {
  const id = SWARM_IDS[index];
  if (!id) throw new Error(`no swarm quake ${index}`);
  return {
    ...USGS_SAMPLE,
    features: [
      syntheticFeature(id, SWARM_T + index * 30 * MINUTE, 35.7 + index * 0.01, -117.5, 3.9, fetchedAt),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// EONET

/** When the EONET fixtures were fetched. */
export const EONET_NOW = Date.parse("2026-09-24T02:05:56Z");
export const EONET_EVENTS = JSON.parse(fixtureText("eonet/events_sample.json")) as unknown;
export const EONET_SOURCES = parseEonetSources(
  JSON.parse(fixtureText("eonet/sources_sample.json")) as unknown,
);

export async function seedEonet(db: Db): Promise<EventRecord[]> {
  const records = normalizeEonet(
    EONET_EVENTS,
    EONET_SOURCES,
    EONET_NOW,
    `eonet@${new Date(EONET_NOW).toISOString()}`,
    EONET_NOW,
  );
  await insertEvents(db, records, "ingest", EONET_NOW);
  return records;
}

// ---------------------------------------------------------------------------------------------
// FIRMS

/** Synthetic NOAA-20 file: 40 detections on 2026-09-21 and 2026-09-22 in 3 cells. */
export const FIRMS_SAMPLE = fixtureText("firms/sample.csv");
export const FIRMS_FETCHED = Date.UTC(2026, 8, 23, 1, 0);
export const FIRMS_LAST_MODIFIED = "Wed, 23 Sep 2026 00:40:51 GMT";

/** Stores the sample as NOAA-20 batch versions (one per acquisition date). */
export async function seedFirms(
  db: Db,
  csv = FIRMS_SAMPLE,
  fetchId = String(FIRMS_FETCHED),
  fetchedAt = FIRMS_FETCHED,
): Promise<EventRecord[]> {
  const batches = groupBatches(parseFirmsCsv(csv), "N20", fetchedAt, fetchId, FIRMS_LAST_MODIFIED);
  await insertEvents(db, batches, "ingest", fetchedAt);
  return batches;
}
