// Synthetic events for the model, brief, and Ask tests. Built with the real fact builders and
// detectors; every aircraft id is a digest of a synthetic label, never a real identifier.
import { migrate, openDb, type Db } from "../../../src/db/client.ts";
import { insertEvents, linkEvents } from "../../../src/db/queries.ts";
import { detectCircling } from "../../../src/detectors/circling.ts";
import { buildFireGrowthDetection } from "../../../src/detectors/fire-growth.ts";
import { detectQuakeClusters } from "../../../src/detectors/quake-cluster.ts";
import type { FlightSample } from "../../../src/detectors/types.ts";
import { count, label, upstream, utcDate, utcTime } from "../../../src/events/facts.ts";
import type { EventRecord, Facts } from "../../../src/events/types.ts";
import { sha256Hex } from "../../../src/lib/digest.ts";
import { recordKeyOf, versionId } from "../../../src/lib/ids.ts";
import { localSolarDayKey } from "../../../src/lib/time.ts";

/** The brief's window end: 2026-09-23T12:00:00Z. */
export const T0 = Date.UTC(2026, 8, 23, 12, 0, 0);
export const MINUTE = 60_000;
export const HOUR = 3_600_000;

export async function freshDb(): Promise<Db> {
  const db = await openDb(":memory:");
  await migrate(db);
  return db;
}

export interface QuakeOptions {
  mag: number;
  t: number;
  lat?: number;
  lon?: number;
  place?: string;
  type?: string;
  fetchedAt?: number;
  updated?: number;
  deleted?: boolean;
}

export function quake(nativeId: string, o: QuakeOptions): EventRecord {
  const updated = o.updated ?? o.t + MINUTE;
  const facts: Facts = {
    mag: upstream(o.mag),
    depth_km: upstream(8.2, "km"),
    place: label(o.place ?? "10 km N of Ridgecrest, CA"),
    time: utcTime(o.t),
    date: utcDate(o.t),
    type: label(o.type ?? "earthquake"),
  };
  const raw = JSON.stringify({ id: nativeId, mag: o.mag, updated });
  return {
    id: versionId("usgs", nativeId, updated),
    recordKey: recordKeyOf("usgs", nativeId),
    source: "usgs",
    kind: "earthquake",
    occurredAt: o.t,
    fetchedAt: o.fetchedAt ?? updated,
    sourceUpdatedAt: updated,
    lat: o.lat ?? 35.7,
    lon: o.lon ?? -117.6,
    bbox: null,
    title: `M ${o.mag}, ${o.place ?? "10 km N of Ridgecrest, CA"}`,
    facts,
    meta: o.deleted ? { deleted: true } : { ids: [nativeId] },
    raw,
    rawGz: null,
    rawDigest: sha256Hex(raw),
    fetchId: null,
    supersedes: null,
  };
}

export function naturalEvent(
  nativeId: string,
  title: string,
  category: { id: string; title: string },
  t: number,
): EventRecord {
  const raw = JSON.stringify({ id: nativeId, title });
  return {
    id: versionId("eonet", nativeId, sha256Hex(raw).slice(0, 12)),
    recordKey: recordKeyOf("eonet", nativeId),
    source: "eonet",
    kind: "natural_event",
    occurredAt: t,
    fetchedAt: t + MINUTE,
    sourceUpdatedAt: t,
    lat: 20.5,
    lon: -110.2,
    bbox: null,
    title,
    facts: {
      title: label(title),
      category: label(category.title),
      date: utcDate(t),
      source: label("NASA"),
    },
    meta: { categories: [category], closed: null },
    raw,
    rawGz: null,
    rawDigest: sha256Hex(raw),
    fetchId: null,
    supersedes: null,
  };
}

/** A synthetic aircraft digest (the shape of a real one, from a made-up label). */
export function aircraftDigest(labelText: string): string {
  return sha256Hex(`synthetic-aircraft:${labelText}`);
}

/** Samples of one aircraft turning 35 degrees every 30 s for 13 samples (420 degrees in 6 min). */
export function orbit(aircraft: string, start: number): FlightSample[] {
  return Array.from({ length: 13 }, (_, i) => ({
    aircraft,
    t: start + i * 30_000,
    lat: 51.4 + i * 0.001,
    lon: -0.4 - i * 0.001,
    altFt: 7000 + i * 10,
    groundSpeedKt: 210,
    // 70 deg per 30 s sample: 840 deg in 6 minutes, over the calibrated 720.
    trackDeg: (i * 70) % 360,
    onGround: false,
    positionAgeS: 1,
  }));
}

/** The redacted track a circling detection cites (source flights, so its id carries the digest). */
export function aircraftTrack(aircraft: string, samples: FlightSample[]): EventRecord {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) throw new Error("a track needs samples");
  const raw = JSON.stringify(samples);
  return {
    id: versionId("flights", `track:${aircraft}:${first.t}`, last.t),
    recordKey: recordKeyOf("flights", `track:${aircraft}:${first.t}`),
    source: "flights",
    kind: "aircraft_track",
    occurredAt: first.t,
    fetchedAt: last.t,
    sourceUpdatedAt: last.t,
    lat: first.lat,
    lon: first.lon,
    bbox: null,
    title: "Aircraft track",
    facts: { samples: count(samples.length), start: utcTime(first.t), end: utcTime(last.t) },
    meta: { provider: "synthetic" },
    raw,
    rawGz: null,
    rawDigest: sha256Hex(raw),
    fetchId: null,
    supersedes: null,
  };
}

export interface Scene {
  cluster: EventRecord;
  clusterMembers: string[];
  fireGrowth: EventRecord;
  circling: EventRecord[];
  tracks: EventRecord[];
  aircraft: string[];
  quakes: EventRecord[];
  storm: EventRecord;
  wildfire: EventRecord;
  quarryBlast: EventRecord;
  endedQuake: string;
}

/**
 * A day of synthetic data ending at T0: a quake cluster (4 quakes), a large lone quake, a quarry
 * blast, an ended quake, a fire growth detection found an hour ago, 4 circling episodes, a storm,
 * and a wildfire (EONET).
 */
export function buildScene(): { events: EventRecord[]; links: Array<[string, string[]]>; scene: Scene } {
  const clusterQuakes = [0, 1, 2, 3].map((i) =>
    quake(`ci900${i}`, {
      mag: [2.5, 3.1, 2.8, 2.2][i] ?? 2,
      t: T0 - 5 * HOUR + i * 20 * MINUTE,
      lat: 35.7 + i * 0.01,
      lon: -117.6 + i * 0.01,
    }),
  );
  const big = quake("us7000big", {
    mag: 5.4,
    t: T0 - 3 * HOUR,
    lat: -20.1,
    lon: -70.3,
    place: "45 km W of Iquique, Chile",
  });
  const quarryBlast = quake("ci8000qb", { mag: 6.1, t: T0 - 2 * HOUR, type: "quarry blast", lat: 34, lon: -117 });
  const ended = quake("nc7000gone", { mag: 4.9, t: T0 - 4 * HOUR, lat: 38, lon: -122 });
  const endedTombstone = { ...quake("nc7000gone", { mag: 4.9, t: T0 - 4 * HOUR, lat: 38, lon: -122, updated: T0 - HOUR, deleted: true }) };

  const [cluster] = detectQuakeClusters(clusterQuakes);
  if (!cluster) throw new Error("the synthetic quakes must form a cluster");

  const lon = -117.5;
  const day1 = localSolarDayKey(T0 - 30 * HOUR, lon);
  const fire = buildFireGrowthDetection(
    { cellKey: "34,-118", day0: day1 - 1, day1, count0: 120, count1: 300, growthPct: 150, satellites: ["N20", "N21"] },
    ["firms:cell:34_-118:a@1", "firms:cell:34_-118:b@1"],
    ["2026-09-21", "2026-09-22"],
    T0 - HOUR,
  );

  const aircraft = ["one", "two", "three", "four"].map(aircraftDigest);
  const circling: EventRecord[] = [];
  const tracks: EventRecord[] = [];
  aircraft.forEach((a, i) => {
    const samples = orbit(a, T0 - (10 - i) * HOUR);
    const [hit] = detectCircling(samples, "London");
    if (!hit) throw new Error("the synthetic orbit must circle");
    circling.push(hit.result.detection);
    tracks.push(aircraftTrack(a, hit.track));
  });

  const storm = naturalEvent("EONET_1", "Hurricane Synthetic", { id: "severeStorms", title: "Severe Storms" }, T0 - 6 * HOUR);
  const wildfire = naturalEvent("EONET_2", "Wildfire Synthetic", { id: "wildfires", title: "Wildfires" }, T0 - 2 * HOUR);

  const events = [
    ...clusterQuakes,
    big,
    quarryBlast,
    ended,
    endedTombstone,
    cluster.detection,
    fire.detection,
    ...circling,
    ...tracks,
    storm,
    wildfire,
  ];
  const links: Array<[string, string[]]> = [
    [cluster.detection.id, cluster.members],
    ...circling.map((c, i): [string, string[]] => [c.id, [tracks[i]?.id ?? ""]]),
  ];
  return {
    events,
    links,
    scene: {
      cluster: cluster.detection,
      clusterMembers: cluster.members,
      fireGrowth: fire.detection,
      circling,
      tracks,
      aircraft,
      quakes: [...clusterQuakes, big],
      storm,
      wildfire,
      quarryBlast,
      endedQuake: ended.recordKey,
    },
  };
}

export async function seedScene(db: Db, order: "forward" | "reverse" = "forward"): Promise<Scene> {
  const { events, links, scene } = buildScene();
  const list = order === "forward" ? events : [...events].reverse();
  for (const e of list) await insertEvents(db, [e], "ingest", T0);
  for (const [parent, children] of links) await linkEvents(db, parent, children);
  return scene;
}
