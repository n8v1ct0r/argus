import { expect, test } from "@playwright/test";
import { config } from "../../argus.config.ts";
import { migrate, openDb } from "../../src/db/client.ts";
import { getEvents, insertEvents } from "../../src/db/queries.ts";
import { detectQuakeClusters } from "../../src/detectors/quake-cluster.ts";
import { label, upstream } from "../../src/events/facts.ts";
import type { EventRecord } from "../../src/events/types.ts";
import { sha256Hex } from "../../src/lib/digest.ts";
import { EARTH_RADIUS_KM } from "../../src/lib/geo.ts";

const T0 = Date.UTC(2026, 8, 22, 0, 0, 0);
const HOUR = 3_600_000;
const MINUTE = 60_000;
const KM_PER_DEG_LAT = (EARTH_RADIUS_KM * Math.PI) / 180;
const cfg = config.detectors.quakeCluster;

interface QuakeSpec {
  id: string;
  t: number;
  lat?: number;
  lon?: number;
  mag?: number | string;
  type?: string;
  place?: string;
  fetchedAt?: number;
  deleted?: boolean;
}

/** A synthetic USGS earthquake version shaped like the usgs adapter's output. */
function quake(q: QuakeSpec): EventRecord {
  const fetchedAt = q.fetchedAt ?? q.t + 10 * MINUTE;
  const raw = JSON.stringify({ id: q.id, t: q.t, mag: q.mag ?? 2.5 });
  return {
    id: `usgs:${q.id}@${fetchedAt}`,
    recordKey: `usgs:${q.id}`,
    source: "usgs",
    kind: "earthquake",
    occurredAt: q.t,
    fetchedAt,
    sourceUpdatedAt: fetchedAt,
    lat: q.lat ?? 35.7,
    lon: q.lon ?? -117.5,
    bbox: null,
    title: `M ${q.mag ?? 2.5}`,
    facts: {
      mag: upstream(q.mag ?? 2.5),
      type: label(q.type ?? "earthquake"),
      place: label(q.place ?? `near ${q.id}`),
    },
    meta: q.deleted ? { deleted: true } : null,
    raw,
    rawGz: null,
    rawDigest: sha256Hex(raw),
    fetchId: null,
    supersedes: null,
  };
}

/** Swarm near one spot: five qualifying quakes over 3 hours plus events that must not count. */
function swarm(): EventRecord[] {
  return [
    quake({ id: "ci1", t: T0, mag: 2.4 }),
    quake({
      id: "ci2",
      t: T0 + 40 * MINUTE,
      lat: 35.71,
      mag: "3.10",
      place: "8 km E of Testville, CA",
    }),
    quake({ id: "ci3", t: T0 + 90 * MINUTE, lon: -117.49, mag: 2.8 }),
    quake({ id: "ci4", t: T0 + 2 * HOUR, lat: 35.69, mag: 2.2 }),
    quake({ id: "ci5", t: T0 + 3 * HOUR, mag: 2.6 }),
    // An older version of ci1: revisions must not count as extra quakes.
    quake({ id: "ci1", t: T0, mag: 2.3, fetchedAt: T0 + 5 * MINUTE }),
    // Excluded: wrong type, below the magnitude floor, too far, and a deleted quake.
    quake({ id: "ci6", t: T0 + HOUR, mag: 3.0, type: "quarry blast" }),
    quake({ id: "ci7", t: T0 + HOUR, mag: 1.2 }),
    quake({ id: "ci8", t: T0 + HOUR, lat: 40.0, mag: 4.0 }),
    quake({ id: "ci9", t: T0 + HOUR, mag: 3.5, fetchedAt: T0 + 2 * HOUR }),
    quake({ id: "ci9", t: T0 + HOUR, mag: 3.5, fetchedAt: T0 + 4 * HOUR, deleted: true }),
  ];
}

test("a swarm forms one cluster with measured, citable facts", async () => {
  const results = detectQuakeClusters(swarm());
  expect(results).toHaveLength(1);
  const [only] = results;
  const d = only!.detection;

  expect(only!.members).toEqual([
    `usgs:ci1@${T0 + 10 * MINUTE}`,
    `usgs:ci2@${T0 + 50 * MINUTE}`,
    `usgs:ci3@${T0 + 100 * MINUTE}`,
    `usgs:ci4@${T0 + 130 * MINUTE}`,
    `usgs:ci5@${T0 + 190 * MINUTE}`,
  ]);
  expect(d.id).toMatch(/^argus:quake-cluster:[0-9a-f]{12}$/);
  expect(d.recordKey).toBe("argus:quake-cluster:usgs:ci1");
  expect(d.source).toBe("argus");
  expect(d.kind).toBe("detection");
  expect(d.occurredAt).toBe(T0 + 3 * HOUR);
  expect(d.title).toBe("Earthquake cluster: 5 quakes near 8 km E of Testville, CA");

  expect(d.facts.count?.text).toBe("5");
  // Copied exactly from the strongest member, trailing zero included.
  expect(d.facts.max_mag?.text).toBe("3.10");
  expect(d.facts.place?.text).toBe("8 km E of Testville, CA");
  expect(d.facts.span_hours?.text).toBe("3.0");
  expect(d.facts.first_time?.text).toBe("00:00 UTC");
  expect(d.facts.last_time?.text).toBe("03:00 UTC");
  expect(d.facts.date?.text).toBe("2026-09-22");
  const maxKm = d.facts.max_distance_km?.value as number;
  expect(maxKm).toBeGreaterThan(0);
  expect(maxKm).toBeLessThanOrEqual(cfg.radiusKm);
  expect(d.facts.max_distance_km?.text).toBe(maxKm.toFixed(1));
  // Thresholds are metadata, never citable facts.
  expect(Object.keys(d.facts)).not.toContain("thresholds");
  expect(d.meta).toMatchObject({
    detector: "quake-cluster",
    anchor: `usgs:ci1@${T0 + 10 * MINUTE}`,
  });
  expect(d.meta?.thresholds).toEqual({ ...cfg, quakeTypes: [...cfg.quakeTypes] });

  expect(d.lat).toBeCloseTo(35.7, 1);
  expect(d.lon).toBeCloseTo(-117.5, 1);
  expect(d.bbox).toEqual({ minLat: 35.69, minLon: -117.5, maxLat: 35.71, maxLon: -117.49 });
  expect(d.rawDigest).toBe(sha256Hex(d.raw ?? ""));
  expect(JSON.parse(d.raw ?? "{}").members).toHaveLength(5);

  // The record satisfies the store's schema and survives a round trip.
  const db = await openDb(":memory:");
  await migrate(db);
  expect(await insertEvents(db, [d], "ingest", T0)).toBe(1);
  expect((await getEvents(db, [d.id]))[0]?.facts).toEqual(d.facts);
});

test("cluster ids are content addressed: input order does not matter, thresholds do", () => {
  const events = swarm();
  const forward = detectQuakeClusters(events).map((r) => r.detection.id);
  const reversed = detectQuakeClusters([...events].reverse()).map((r) => r.detection.id);
  expect(reversed).toEqual(forward);
  const wider = detectQuakeClusters(events, { ...cfg, radiusKm: cfg.radiusKm + 5 });
  expect(wider.map((r) => r.detection.id)).not.toEqual(forward);
});

test("a chain of quakes 20 km and 5 h apart never forms one cluster spanning more than R and T", () => {
  const chain = Array.from({ length: 6 }, (_, i) =>
    quake({ id: `nc${i}`, t: T0 + i * 5 * HOUR, lat: 35 + (i * 20) / KM_PER_DEG_LAT, mag: 3 }),
  );
  expect(detectQuakeClusters(chain)).toEqual([]);

  // With a pair threshold, only neighbours pair up: nothing reaches 40 km or 10 h.
  const pairs = detectQuakeClusters(chain, { ...cfg, minCount: 2 });
  expect(pairs).toHaveLength(5);
  for (const [i, r] of pairs.entries()) {
    expect(r.members).toHaveLength(2);
    expect(r.members[0]).toContain(`nc${i}@`);
    expect(r.members[1]).toContain(`nc${i + 1}@`);
    expect(r.detection.facts.max_distance_km?.value as number).toBeLessThanOrEqual(cfg.radiusKm);
    expect(r.detection.facts.span_hours?.value as number).toBeLessThanOrEqual(cfg.windowHours);
  }
});

test("a cluster whose members are a subset of another cluster's is dropped", () => {
  const base = [0, 1, 2, 3].map((h) => quake({ id: `ak${h}`, t: T0 + h * HOUR, mag: 3 }));
  const three = { ...cfg, minCount: 3 };

  // Anchor ak1 would hold {ak1, ak2, ak3}, inside ak0's {ak0..ak3}.
  const nested = detectQuakeClusters(base, three);
  expect(nested).toHaveLength(1);
  expect(nested[0]?.detection.facts.count?.text).toBe("4");

  // A later quake gives ak1 a member ak0 lacks, so both stay; ak2's set is inside ak1's.
  const late = quake({ id: "ak9", t: T0 + 6.5 * HOUR, mag: 3 });
  const overlapping = detectQuakeClusters([...base, late], three);
  expect(overlapping.map((r) => r.detection.recordKey)).toEqual([
    "argus:quake-cluster:usgs:ak0",
    "argus:quake-cluster:usgs:ak1",
  ]);

  // Two quakes at the same instant anchor identical sets; only the first is kept.
  const twin = quake({ id: "ak0b", t: T0, mag: 3 });
  expect(detectQuakeClusters([...base, twin], { ...cfg, minCount: 5 })).toHaveLength(1);
});

test("a cluster across the antimeridian gets a centroid near 180, not 0", () => {
  const quakes = [179.95, -179.95, 179.97, -179.97].map((lon, i) =>
    quake({ id: `us${i}`, t: T0 + i * HOUR, lat: -17.9, lon, mag: 4.1 }),
  );
  const [only] = detectQuakeClusters(quakes);
  expect(Math.abs(only?.detection.lon ?? 0)).toBeGreaterThan(179.9);
  expect(only?.detection.bbox?.minLon).toBeCloseTo(179.95, 6);
  expect(only?.detection.bbox?.maxLon).toBeCloseTo(-179.95, 6);
});
