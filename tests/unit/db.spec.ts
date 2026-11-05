import { expect, test } from "@playwright/test";
import { config } from "../../argus.config.ts";
import { upstream } from "../../src/events/facts.ts";
import type { EventRecord } from "../../src/events/types.ts";
import { migrate, openDb, type Db } from "../../src/db/client.ts";
import {
  acquireLease,
  chargeWrites,
  getEvents,
  insertEvents,
  latestVersion,
  listEvents,
  recordFailure,
  WriteBudgetExceeded,
} from "../../src/db/queries.ts";
import { sha256Hex } from "../../src/lib/digest.ts";

async function freshDb(): Promise<Db> {
  const db = await openDb(":memory:");
  await migrate(db);
  return db;
}

function quake(id: string, updated: number, mag: number): EventRecord {
  const raw = JSON.stringify({ id, properties: { mag, updated } });
  return {
    id: `usgs:${id}@${updated}`,
    recordKey: `usgs:${id}`,
    source: "usgs",
    kind: "earthquake",
    occurredAt: 1_790_000_000_000,
    fetchedAt: updated,
    sourceUpdatedAt: updated,
    lat: 35.3,
    lon: -117.8,
    bbox: null,
    title: `M ${mag}`,
    facts: { mag: upstream(mag) },
    meta: null,
    raw,
    rawGz: null,
    rawDigest: sha256Hex(raw),
    fetchId: null,
    supersedes: null,
  };
}

test("event versions are immutable and inserts are idempotent", async () => {
  const db = await freshDb();
  expect(await insertEvents(db, [quake("ci1", 1, 4.6)])).toBe(1);
  expect(await insertEvents(db, [quake("ci1", 1, 4.6)])).toBe(0);
  // A revision is a new version with its own id; the first stays untouched.
  expect(await insertEvents(db, [quake("ci1", 2, 4.8)])).toBe(1);
  const [first] = await getEvents(db, ["usgs:ci1@1"]);
  expect(first?.facts.mag?.text).toBe("4.6");
  expect((await latestVersion(db, "usgs:ci1"))?.facts.mag?.text).toBe("4.8");
  expect(await listEvents(db, { kinds: ["earthquake"] })).toHaveLength(2);
});

test("the write guard stops writes before the daily budget is exceeded", async () => {
  const db = await freshDb();
  const rowsAllowed = Math.floor(config.writeGuard.askWritesPerDay / config.writeGuard.indexFactor);
  await chargeWrites(db, rowsAllowed, "ask");
  await expect(chargeWrites(db, 1, "ask")).rejects.toBeInstanceOf(WriteBudgetExceeded);
  // Ingest has its own larger headroom inside the total.
  await chargeWrites(db, 10, "ingest");
});

test("backoff grows exponentially and the lease is single-flight", async () => {
  const db = await freshDb();
  const a = await recordFailure(db, "flights", 429, 60_000, 900_000, 0);
  const b = await recordFailure(db, "flights", 429, 60_000, 900_000, 0);
  expect(a.nextAllowedAt).toBe(60_000);
  expect(b.nextAllowedAt).toBe(120_000);
  expect(await acquireLease(db, "ingest", "worker-a", 30_000, 0)).toBe(true);
  expect(await acquireLease(db, "ingest", "worker-b", 30_000, 1_000)).toBe(false);
  expect(await acquireLease(db, "ingest", "worker-b", 30_000, 31_000)).toBe(true);
});
