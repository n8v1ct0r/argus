import { expect, test } from "@playwright/test";
import { migrate, openDb, type Db } from "../../src/db/client.ts";
import { getEvents, getLinks, insertEvents } from "../../src/db/queries.ts";
import { runFireGrowthDetector } from "../../src/ingest/detections.ts";
import {
  dayComplete,
  groupBatches,
  pairDates,
  parseFirmsCsv,
  recomputePresence,
  storePresence,
  subcellOf,
  type FirmsSatellite,
} from "../../src/ingest/sources/firms.ts";
import {
  MS_PER_DAY,
  MS_PER_HOUR,
  solarDayStartMs,
  solarNoonMs,
  utcDay,
} from "../../src/lib/time.ts";

// Synthetic FIRMS rows in the real VIIRS column layout. Day K is 2026-09-20 (local solar day key).
const K = Math.floor(Date.UTC(2026, 8, 20) / MS_PER_DAY);
const HEADER =
  "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight";
const SATELLITES: FirmsSatellite[] = ["N20", "N21"];
// Scored once day K has ended everywhere plus the 6 h margin.
const NOW = solarDayStartMs(K, -180) + MS_PER_DAY + 7 * MS_PER_HOUR;

function line(lat: number, lon: number, ms: number, confidence: string): string {
  const iso = new Date(ms).toISOString();
  const date = iso.slice(0, 10);
  const hhmm = iso.slice(11, 13) + iso.slice(14, 16);
  return `${lat.toFixed(4)},${lon.toFixed(4)},330.1,0.4,0.37,${date},${hhmm},N,VIIRS,${confidence},2.0NRT,290.2,5.1,D`;
}

/** `n` nominal detections in cell "10,20" at local solar noon of `dayKey`. */
function cellRows(dayKey: number, n: number): string[] {
  const at = solarNoonMs(dayKey, 20.5);
  return Array.from({ length: n }, (_, i) => line(10.2 + i * 0.001, 20.3, at, "nominal"));
}

/** One low-confidence detection per UTC date far from the cell, so every date has a batch. */
function fillerRows(dates: string[]): string[] {
  return dates.map((d) => line(0.5, 0.5, Date.parse(`${d}T12:00:00Z`), "low"));
}

async function freshDb(): Promise<Db> {
  const db = await openDb(":memory:");
  await migrate(db);
  return db;
}

async function storeBatches(db: Db, perSatellite: { day0: number; day1: number }): Promise<void> {
  const dates = pairDates(K - 1, K);
  for (const sat of SATELLITES) {
    const csv = [
      HEADER,
      ...fillerRows(dates),
      ...cellRows(K - 1, perSatellite.day0),
      ...cellRows(K, perSatellite.day1),
    ].join("\n");
    const batches = groupBatches(parseFirmsCsv(csv), sat, NOW - MS_PER_HOUR, "test-fetch", null);
    await insertEvents(db, batches, "ingest", NOW - MS_PER_HOUR);
  }
  await recomputePresence(db, NOW);
}

/** History days before the pair: one sub-cell in cell "0,0" only, so cell "10,20" is not persistent. */
async function storeHistory(db: Db, days: number[]): Promise<void> {
  const subcells = new Map([[subcellOf(0.5, 0.5), 3]]);
  await storePresence(
    db,
    days.map((dayKey) => ({ dayKey, satellite: "N20", subcells })),
    NOW,
  );
}

test("pair dates cover every UTC date either day touches at any longitude", () => {
  expect(pairDates(K - 1, K)).toEqual([
    utcDay((K - 2) * MS_PER_DAY),
    utcDay((K - 1) * MS_PER_DAY),
    utcDay(K * MS_PER_DAY),
    utcDay((K + 1) * MS_PER_DAY),
  ]);
  expect(dayComplete(K, NOW)).toBe(true);
  expect(dayComplete(K, NOW - 2 * MS_PER_HOUR)).toBe(false);
  expect(dayComplete(K + 1, NOW)).toBe(false);
});

test("after FIRMS, a growing cell becomes a fire-growth detection citing both cell days", async () => {
  const db = await freshDb();
  // 60 detections per satellite on day K-1 (120 summed), 130 per satellite on day K (260).
  await storeBatches(db, { day0: 60, day1: 130 });
  await storeHistory(db, [K - 7, K - 6, K - 5, K - 4, K - 3]);

  const run = await runFireGrowthDetector(db, NOW);
  expect(run).toMatchObject({ examined: 1, found: 1, stored: 1, skipped: 0 });

  const rs = await db.execute("SELECT id FROM events WHERE kind = 'detection'");
  const [detection] = await getEvents(
    db,
    rs.rows.map((r) => String(r.id)),
  );
  if (!detection) throw new Error("no detection stored");
  const text = Object.fromEntries(Object.entries(detection.facts).map(([k, f]) => [k, f.text]));
  expect(text).toMatchObject({
    cell: "10,20",
    count_day0: "120",
    count_day1: "260",
    growth_pct: "116",
    date_day0: utcDay((K - 1) * MS_PER_DAY),
    date_day1: utcDay(K * MS_PER_DAY),
  });
  expect(detection.fetchedAt).toBe(NOW);

  // Both cited cell days are stored, complete, and count exactly the detection's numbers.
  const evidence = await getEvents(db, await getLinks(db, detection.id));
  expect(evidence.map((e) => [e.kind, e.facts.count?.text, e.meta?.complete])).toEqual([
    ["fire_cell_day", "120", true],
    ["fire_cell_day", "260", true],
  ]);

  // Scoring again stores nothing new.
  expect(await runFireGrowthDetector(db, NOW + MS_PER_HOUR)).toMatchObject({ stored: 0 });
});

test("fire growth waits for persistence history and for complete days", async () => {
  const db = await freshDb();
  await storeBatches(db, { day0: 60, day1: 130 });
  // Only 2 history days plus the filler day: under persistenceMinDays (5).
  await storeHistory(db, [K - 4, K - 3]);
  const waiting = await runFireGrowthDetector(db, NOW);
  expect(waiting).toMatchObject({ examined: 0, stored: 0 });
  expect(waiting.note).toContain("waiting for persistence history");

  await storeHistory(db, [K - 7, K - 6, K - 5]);
  // Day K has not ended at every longitude plus the margin yet.
  expect(await runFireGrowthDetector(db, NOW - 2 * MS_PER_HOUR)).toMatchObject({ examined: 0 });
  expect(await runFireGrowthDetector(db, NOW)).toMatchObject({ examined: 1, stored: 1 });
});

test("a pair whose batches were pruned is not scored", async () => {
  const db = await freshDb();
  await storeBatches(db, { day0: 60, day1: 130 });
  await storeHistory(db, [K - 7, K - 6, K - 5, K - 4, K - 3]);
  const [oldest] = pairDates(K - 1, K);
  await db.execute({
    sql: "DELETE FROM events WHERE kind = 'fire_batch' AND record_key = ?",
    args: [`firms:N21:${oldest}`],
  });
  expect(await runFireGrowthDetector(db, NOW)).toMatchObject({ examined: 0, stored: 0 });
});
