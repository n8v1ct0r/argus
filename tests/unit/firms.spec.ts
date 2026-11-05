import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { config } from "../../argus.config.ts";
import { migrate, openDb, type Db } from "../../src/db/client.ts";
import { getEvents, latestVersion, listEvents } from "../../src/db/queries.ts";
import { count, label } from "../../src/events/facts.ts";
import type { EventRecord } from "../../src/events/types.ts";
import {
  bootstrapPresence,
  cellCenter,
  cellKeyOf,
  cellOfSubcell,
  fireCellsForWindow,
  fireGrowthDue,
  groupBatches,
  loadFireDayCounts,
  materializeCellDay,
  parseFirmsCsv,
  presenceFromRows,
  presenceHistory,
  recomputePresence,
  rowDayKey,
  runFirms,
  sevenDayUrl,
  solarDayLabel,
  subcellOf,
  type FirmsRow,
} from "../../src/ingest/sources/firms.ts";
import type { FetchImpl } from "../../src/ingest/types.ts";
import { sha256Hex } from "../../src/lib/digest.ts";
import { EVENT_ID_PATTERN } from "../../src/lib/ids.ts";
import { gunzipText } from "../../src/lib/gzip.ts";
import { persistentCells } from "../../src/detectors/fire-mask.ts";
import { MS_PER_DAY, MS_PER_HOUR, utcDay } from "../../src/lib/time.ts";

// Synthetic NOAA-20 file: 40 detections over 2026-09-21 and 2026-09-22 in 3 cells, confidence
// written both as words (files) and letters (API), rows deliberately out of time order.
const SAMPLE = readFileSync(new URL("../fixtures/firms/sample.csv", import.meta.url), "utf8");
const SAMPLE_LINES = SAMPLE.trimEnd().split("\n").slice(1);
const HEADER = SAMPLE.split("\n")[0] ?? "";

// NOAA-21 reports 3 detections in the California cell on 2026-09-22 (2 counted).
const N21_CSV = [
  HEADER,
  "34.25,-118.31,350.1,0.46,0.39,2026-09-22,2138,N21,high,2.0NRT,299.4,12.0,D",
  "34.44,-118.55,331.7,0.46,0.39,2026-09-22,2138,N21,n,2.0NRT,295.8,6.1,D",
  "34.61,-118.72,304.2,0.46,0.39,2026-09-22,2138,N21,low,2.0NRT,293.2,1.3,D",
].join("\n");

const N20_URL = config.sources.firms.files.N20;
const N21_URL = config.sources.firms.files.N21;
const A = "34,-119"; // California, cell center lon -118.5
const B = "-10,25"; // Zambia, cell center lon 25.5
const C = "61,129"; // Yakutia, cell center lon 129.5
const D = Date.UTC(2026, 8, 21) / MS_PER_DAY; // local solar day 2026-09-21
const T1 = Date.UTC(2026, 8, 23, 1, 0);
const T2 = T1 + MS_PER_HOUR;
const T3 = T2 + MS_PER_HOUR;
const T4 = T3 + MS_PER_HOUR;
const LM1 = "Wed, 23 Sep 2026 00:40:51 GMT";
const LM2 = "Wed, 23 Sep 2026 01:40:51 GMT";
const LM3 = "Wed, 23 Sep 2026 02:40:51 GMT";
const LM_N21 = "Wed, 23 Sep 2026 00:44:44 GMT";
/** No persistent sub-cells. */
const NO_MASK: ReadonlySet<number> = new Set();

async function freshDb(): Promise<Db> {
  const db = await openDb(":memory:");
  await migrate(db);
  return db;
}

interface Served {
  lastModified: string;
  body: string;
}

interface Call {
  method: string;
  satellite: string;
  userAgent: string | null;
}

/** Fake FIRMS server: HEAD and GET per URL, Last-Modified from `served`, 404 otherwise. */
function fakeFetch(served: Record<string, Served>, calls: Call[] = []): FetchImpl {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      satellite: url === N20_URL ? "N20" : url === N21_URL ? "N21" : url,
      userAgent: new Headers(init?.headers).get("user-agent"),
    });
    const file = served[url];
    if (!file) return new Response("not found", { status: 404 });
    const headers = {
      "last-modified": file.lastModified,
      "content-length": String(Buffer.byteLength(file.body)),
    };
    return new Response(method === "HEAD" ? null : file.body, { status: 200, headers });
  }) as FetchImpl;
}

function files(n20Body: string, n20Modified: string): Record<string, Served> {
  return {
    [N20_URL]: { lastModified: n20Modified, body: n20Body },
    [N21_URL]: { lastModified: LM_N21, body: N21_CSV },
  };
}

function csvWithout(...drop: string[]): string {
  return [HEADER, ...SAMPLE_LINES.filter((l) => !drop.includes(l))].join("\n");
}

function csvOf(e: EventRecord | null | undefined): string {
  if (!e?.rawGz) throw new Error("expected a gzipped batch");
  return gunzipText(e.rawGz);
}

function line(prefix: string): string {
  const found = SAMPLE_LINES.find((l) => l.startsWith(prefix));
  if (!found) throw new Error(`no fixture line starts with ${prefix}`);
  return found;
}

function findRow(rows: FirmsRow[], date: string, time: string, cell: string): FirmsRow {
  const row = rows.find(
    (r) => r.acqDate === date && r.acqTime === time && cellKeyOf(r.lat, r.lon) === cell,
  );
  if (!row) throw new Error(`no row ${date} ${time} ${cell}`);
  return row;
}

async function ingestSample(db: Db): Promise<void> {
  const result = await runFirms(db, { now: T1, fetchImpl: fakeFetch(files(SAMPLE, LM1)) });
  expect(result).toEqual({ source: "firms", fetched: 43, inserted: 3, status: "ok" });
}

test("parseFirmsCsv keys on column names and normalizes both confidence spellings", () => {
  const rows = parseFirmsCsv(SAMPLE);
  expect(rows).toHaveLength(40);
  const tally: Record<string, number> = {};
  for (const r of rows) tally[r.confidence] = (tally[r.confidence] ?? 0) + 1;
  expect(tally).toEqual({ low: 9, nominal: 17, high: 14 });
  expect(rows.every((r) => r.header === HEADER && SAMPLE_LINES.includes(r.line))).toBe(true);

  // The same data with every column in reverse order parses to the same detections.
  const reversed = SAMPLE.trimEnd()
    .split("\n")
    .map((l) => l.split(",").reverse().join(","))
    .join("\n");
  const pick = (r: FirmsRow) => [r.lat, r.lon, r.acqMs, r.confidence];
  expect(parseFirmsCsv(reversed).map(pick)).toEqual(rows.map(pick));

  // BOM, CRLF, upper case letters, and an acq_time without leading zeros.
  const [row] = parseFirmsCsv(
    "\uFEFFacq_time,confidence,longitude,latitude,acq_date\r\n5,H,25.5,-9.5,2026-09-22\r\n",
  );
  expect(row).toMatchObject({
    line: "5,H,25.5,-9.5,2026-09-22",
    lat: -9.5,
    lon: 25.5,
    acqTime: "0005",
    acqMs: Date.UTC(2026, 8, 22, 0, 5),
    confidence: "high",
  });

  // Damage fails loudly instead of becoming a batch version that looks like removals.
  expect(() => parseFirmsCsv("latitude,longitude,acq_date,acq_time\n1,2,2026-09-22,0100")).toThrow(
    /no "confidence" column/,
  );
  expect(() => parseFirmsCsv(`${SAMPLE}34.1,-118.2,344.6,0.46`)).toThrow(/fields/);
  expect(() => parseFirmsCsv(SAMPLE.replace(",high,", ",maybe,"))).toThrow(/confidence/);
  expect(() => parseFirmsCsv(SAMPLE.replace("2026-09-21,0430", "2026-09-31,0430"))).toThrow(
    /acq_date/,
  );
});

test("groupBatches makes one version per acquisition date with a digest over the CSV text", () => {
  const rows = parseFirmsCsv(SAMPLE);
  const batches = groupBatches(rows, "N20", T1, "f1", LM1);
  expect(batches.map((b) => b.id)).toEqual(["firms:N20:2026-09-21@f1", "firms:N20:2026-09-22@f1"]);
  const [b21] = batches;
  expect(b21).toMatchObject({
    recordKey: "firms:N20:2026-09-21",
    source: "firms",
    kind: "fire_batch",
    occurredAt: Date.UTC(2026, 8, 21),
    fetchedAt: T1,
    sourceUpdatedAt: Date.parse(LM1),
    title: "NOAA-20 fire detections on 2026-09-21",
    raw: null,
    fetchId: "f1",
    supersedes: null,
  });
  expect(b21?.facts).toEqual({
    count: count(20),
    date: label("2026-09-21"),
    satellite: label("NOAA-20"),
  });
  expect(b21?.meta).toEqual({
    satellite: "N20",
    lastModified: LM1,
    rows: 20,
    carriedRows: 0,
    digestOf: "csv",
  });

  const csv = csvOf(b21);
  expect(b21?.rawDigest).toBe(sha256Hex(csv));
  const lines = csv.trimEnd().split("\n");
  expect(lines[0]).toBe(HEADER);
  expect([...lines.slice(1)].sort()).toEqual(
    SAMPLE_LINES.filter((l) => l.includes(",2026-09-21,")).sort(),
  );
  // Lines are stored in acquisition order (the file is not), so equal sets hash equal.
  const times = lines.slice(1).map((l) => l.split(",")[6]);
  expect(times).toEqual([...times].sort());
  const reordered = groupBatches([...rows].reverse(), "N20", T2, "f2", LM2);
  expect(reordered.map((b) => b.rawDigest)).toEqual(batches.map((b) => b.rawDigest));
});

test("runFirms sends a HEAD, downloads only on a new Last-Modified, and skips unchanged batches", async () => {
  const db = await freshDb();
  const served = files(SAMPLE, LM1);
  const calls: Call[] = [];
  const fetchImpl = fakeFetch(served, calls);
  const seen = () => calls.splice(0).map((c) => `${c.method} ${c.satellite}`);

  expect(await runFirms(db, { now: T1, fetchImpl })).toEqual({
    source: "firms",
    fetched: 43,
    inserted: 3,
    status: "ok",
  });
  expect(calls.every((c) => c.userAgent === "Argus/0.1 (+https://github.com/n8v1ct0r)")).toBe(true);
  expect(seen()).toEqual(["HEAD N20", "GET N20", "HEAD N21", "GET N21"]);

  // Same Last-Modified: HEAD only (the server ignores conditional GETs).
  expect(await runFirms(db, { now: T2, fetchImpl })).toEqual({
    source: "firms",
    fetched: 0,
    inserted: 0,
    status: "not_modified",
  });
  expect(seen()).toEqual(["HEAD N20", "HEAD N21"]);

  // Rebuilt with the same CSV: one download, every batch digest matches, nothing new.
  served[N20_URL] = { lastModified: LM2, body: SAMPLE };
  expect(await runFirms(db, { now: T3, fetchImpl })).toMatchObject({
    fetched: 40,
    inserted: 0,
    status: "ok",
  });
  expect(seen()).toEqual(["HEAD N20", "GET N20", "HEAD N21"]);

  // FIRMS removed one detection from 2026-09-22: only that date gets a new version.
  const removed = line("-9.38,25.56");
  served[N20_URL] = { lastModified: LM3, body: csvWithout(removed) };
  expect(await runFirms(db, { now: T4, fetchImpl })).toMatchObject({
    fetched: 39,
    inserted: 1,
    status: "ok",
  });
  const latest = await latestVersion(db, "firms:N20:2026-09-22");
  expect(latest?.id).toBe(`firms:N20:2026-09-22@${T4}`);
  expect(latest?.supersedes).toBe(`firms:N20:2026-09-22@${T1}`);
  expect(latest?.facts.count?.text).toBe("19");
  expect(latest?.meta).toMatchObject({ lastModified: LM3, rows: 19 });
  expect(csvOf(latest)).not.toContain(removed);
  // The first version is immutable and still holds the removed line.
  const [first] = await getEvents(db, [`firms:N20:2026-09-22@${T1}`]);
  expect(first?.facts.count?.text).toBe("20");
  expect(csvOf(first)).toContain(removed);
  expect((await latestVersion(db, "firms:N20:2026-09-21"))?.id).toBe(`firms:N20:2026-09-21@${T1}`);

  // Every request went through the fetch log: 4 + 2 + 3 + 3.
  const log = await db.execute("SELECT SUM(requests) AS n FROM fetch_log WHERE source = 'firms'");
  expect(Number(log.rows[0]?.n)).toBe(12);
});

test("a file that rolled past early detections keeps them, and a removal inside it still counts", async () => {
  const db = await freshDb();
  await ingestSample(db);
  const early = SAMPLE_LINES.filter((l) => /,2026-09-21,(0430|1130),/.test(l));
  expect(early).toHaveLength(8);

  // The next file starts at 2026-09-21 16:40: the 8 earlier detections rolled out of the window.
  const served = files(csvWithout(...early), LM2);
  const r = await runFirms(db, { now: T2, fetchImpl: fakeFetch(served) });
  expect(r).toMatchObject({ fetched: 32, inserted: 0, status: "ok" });
  expect((await latestVersion(db, "firms:N20:2026-09-21"))?.facts.count?.text).toBe("20");

  // Same window, and FIRMS also removed a 21:00 detection: the new version keeps the 8 early
  // lines from the previous version and drops the removed one.
  const removed = line("34.29,-118.36");
  served[N20_URL] = { lastModified: LM3, body: csvWithout(...early, removed) };
  expect(await runFirms(db, { now: T3, fetchImpl: fakeFetch(served) })).toMatchObject({
    inserted: 1,
  });
  const latest = await latestVersion(db, "firms:N20:2026-09-21");
  expect(latest?.supersedes).toBe(`firms:N20:2026-09-21@${T1}`);
  expect(latest?.facts.count?.text).toBe("19");
  expect(latest?.meta).toMatchObject({ rows: 19, carriedRows: 8 });
  const csv = csvOf(latest);
  expect(early.every((l) => csv.includes(l))).toBe(true);
  expect(csv).not.toContain(removed);
});

test("local solar days keep a night pass after local midnight with that day's day pass", () => {
  const rows = parseFirmsCsv(SAMPLE);
  // California: 21:00 UTC on 09-21 (13:06 local) and 09:30 UTC on 09-22 (01:36 local) share a day.
  expect(rowDayKey(findRow(rows, "2026-09-21", "2100", A))).toBe(D);
  expect(rowDayKey(findRow(rows, "2026-09-22", "0930", A))).toBe(D);
  expect(rowDayKey(findRow(rows, "2026-09-22", "2048", A))).toBe(D + 1);
  // Zambia: 00:10 UTC on 09-22 (01:52 local) still belongs to 09-21.
  expect(rowDayKey(findRow(rows, "2026-09-22", "0010", B))).toBe(D);
  // Yakutia: 22:30 UTC on 09-21 is already 07:08 on 09-22 there.
  expect(rowDayKey(findRow(rows, "2026-09-21", "1640", C))).toBe(D);
  expect(rowDayKey(findRow(rows, "2026-09-21", "2230", C))).toBe(D + 1);
  expect(solarDayLabel(D)).toBe("2026-09-21");
  expect(cellCenter(A)).toEqual({ lat: 34.5, lon: -118.5 });
  expect(cellKeyOf(-9.12, 25.18)).toBe(B);
});

test("recomputePresence counts nominal and high detections per local solar day, cell, and satellite", async () => {
  const db = await freshDb();
  await ingestSample(db);

  const day0 = await loadFireDayCounts(db, D, NO_MASK);
  expect(day0.satellites).toEqual(["N20"]);
  expect(Object.fromEntries(day0.counts)).toEqual({ [A]: 6, [B]: 7, [C]: 4 });
  const day1 = await loadFireDayCounts(db, D + 1, NO_MASK);
  expect(day1.satellites).toEqual(["N20", "N21"]);
  expect(Object.fromEntries(day1.counts)).toEqual({ [A]: 5, [B]: 3, [C]: 8 });
  const rows = await db.execute(
    "SELECT day_key, satellite FROM fire_presence ORDER BY day_key, satellite",
  );
  expect(rows.rows.map((r) => `${r.day_key}/${r.satellite}`)).toEqual([
    `${D}/N20`,
    `${D + 1}/N20`,
    `${D + 1}/N21`,
  ]);

  // Recomputing unchanged data writes nothing, so the write guard is not charged.
  const billed = async () =>
    Number(
      (
        await db.execute({
          sql: "SELECT billed_writes FROM write_budget WHERE day = ?",
          args: [utcDay(T1)],
        })
      ).rows[0]?.billed_writes,
    );
  const before = await billed();
  await recomputePresence(db, T1);
  expect(await billed()).toBe(before);
});

test("pruning an older batch never shrinks a day that was counted whole", async () => {
  const db = await freshDb();
  await ingestSample(db);
  // Retention (another module) deletes the oldest acquisition date.
  await db.execute({
    sql: "DELETE FROM events WHERE record_key = ?",
    args: ["firms:N20:2026-09-21"],
  });
  await recomputePresence(db, T2);
  // Without the guard, day D would drop to {A: 2, B: 2} and Yakutia on D + 1 to 6.
  expect(Object.fromEntries((await loadFireDayCounts(db, D, NO_MASK)).counts)).toEqual({
    [A]: 6,
    [B]: 7,
    [C]: 4,
  });
  expect(Object.fromEntries((await loadFireDayCounts(db, D + 1, NO_MASK)).counts)).toEqual({
    [A]: 5,
    [B]: 3,
    [C]: 8,
  });
});

test("presenceHistory lists earlier days and their sub-cells, excluding the day asked about", async () => {
  const db = await freshDb();
  await ingestSample(db);
  const all = [A, B, C].sort();
  // History holds sub-cell ids; each maps back to exactly one of the fixture's cells.
  const view = (h: Array<{ dayKey: number; cells: Set<number> }>) =>
    h.map((d) => ({
      dayKey: d.dayKey,
      cells: [...new Set([...d.cells].map(cellOfSubcell))].sort(),
    }));
  expect(view(await presenceHistory(db, D + 2, 30))).toEqual([
    { dayKey: D, cells: all },
    { dayKey: D + 1, cells: all },
  ]);
  expect(view(await presenceHistory(db, D + 1, 30))).toEqual([{ dayKey: D, cells: all }]);
  expect(view(await presenceHistory(db, D + 2, 1))).toEqual([{ dayKey: D + 1, cells: all }]);
});

test("materializeCellDay stores the counted CSV lines of one cell and local solar day", async () => {
  const db = await freshDb();
  await ingestSample(db);

  const ev = await materializeCellDay(db, A, D, T2, NO_MASK);
  expect(ev).toMatchObject({
    recordKey: `firms:cell:${A.replace(",", "_")}:${D}`,
    source: "firms",
    kind: "fire_cell_day",
    fetchedAt: T2,
    lat: 34.5,
    lon: -118.5,
    bbox: { minLat: 34, minLon: -119, maxLat: 35, maxLon: -118 },
    title: "Heat detections in cell 34,-119 on 2026-09-21",
    rawGz: null,
    supersedes: null,
  });
  expect(ev.id).toBe(`firms:cell:${A.replace(",", "_")}:${D}@${ev.rawDigest.slice(0, 12)}`);
  // The whole id survives the event id pattern used on brief text and facts.
  expect(ev.id.match(EVENT_ID_PATTERN)).toEqual([ev.id]);
  expect(ev.rawDigest).toBe(sha256Hex(ev.raw ?? ""));
  expect(ev.facts).toEqual({
    count: count(6),
    cell: label(A),
    date: label("2026-09-21"),
    satellites: label("NOAA-20"),
  });
  expect(ev.meta).toMatchObject({
    satellites: ["N20"],
    complete: true,
    persistentLeftOut: 0,
    batches: [`firms:N20:2026-09-21@${T1}`, `firms:N20:2026-09-22@${T1}`],
  });
  // The 4 counted lines of the 09-21 day pass, then the 2 of the 09-22 night pass; low is left out.
  expect((ev.raw ?? "").trimEnd().split("\n")).toEqual([
    HEADER,
    line("34.14,-118.21"),
    line("34.29,-118.36"),
    line("34.58,-118.67"),
    line("34.72,-118.83"),
    line("34.21,-118.44"),
    line("34.66,-118.79"),
  ]);
  expect(ev.facts.count?.value).toBe((await loadFireDayCounts(db, D, NO_MASK)).counts.get(A));

  // Same lines, same version: nothing new is stored.
  expect((await materializeCellDay(db, A, D, T3, NO_MASK)).id).toBe(ev.id);
  expect(await listEvents(db, { kinds: ["fire_cell_day"] })).toHaveLength(1);

  // The next day sums both satellites; 2026-09-23 is not stored yet, so it is not complete.
  const next = await materializeCellDay(db, A, D + 1, T2, NO_MASK);
  expect(next.facts.count?.text).toBe("5");
  expect(next.facts.satellites?.text).toBe("NOAA-20 and NOAA-21");
  expect(next.facts.date?.text).toBe("2026-09-22");
  expect(next.meta).toMatchObject({ satellites: ["N20", "N21"], complete: false });
  await expect(materializeCellDay(db, A, D + 5, T2, NO_MASK)).rejects.toThrow(
    /No stored FIRMS batch/,
  );
});

test("fireCellsForWindow counts detections in [from, to) per cell over both satellites", async () => {
  const db = await freshDb();
  await ingestSample(db);
  expect(await fireCellsForWindow(db, Date.UTC(2026, 8, 21), Date.UTC(2026, 8, 22))).toEqual([
    { cellKey: B, lat: -9.5, lon: 25.5, count: 5 },
    { cellKey: A, lat: 34.5, lon: -118.5, count: 4 },
    { cellKey: C, lat: 61.5, lon: 129.5, count: 6 },
  ]);
  // The window end is exclusive: the 00:10 detections on 09-22 are left out.
  const late = await fireCellsForWindow(
    db,
    Date.UTC(2026, 8, 21, 21, 0),
    Date.UTC(2026, 8, 22, 0, 10),
  );
  expect(late.map((c) => [c.cellKey, c.count])).toEqual([
    [B, 2],
    [A, 4],
    [C, 2],
  ]);
  // NOAA-20 at 20:48 and NOAA-21 at 21:38 add up.
  const evening = await fireCellsForWindow(
    db,
    Date.UTC(2026, 8, 22, 20, 0),
    Date.UTC(2026, 8, 22, 22, 0),
  );
  expect(evening).toEqual([{ cellKey: A, lat: 34.5, lon: -118.5, count: 5 }]);
});

test("the cold start keeps only local solar days the 7-day file covers whole", () => {
  expect(sevenDayUrl("N20")).toBe(N20_URL.replace("_24h.csv", "_7d.csv"));
  expect(sevenDayUrl("N21")).toMatch(/J2_VIIRS_C2_Global_7d\.csv$/);
  // One detection an hour in Zambia from 2026-09-18 00:00 to 2026-09-21 23:00 UTC.
  const lines: string[] = [];
  for (let h = 0; h < 96; h++) {
    const iso = new Date(Date.UTC(2026, 8, 18) + h * MS_PER_HOUR).toISOString();
    const time = iso.slice(11, 13) + iso.slice(14, 16);
    lines.push(`-9.5,25.5,330.0,0.4,0.4,${iso.slice(0, 10)},${time},N20,nominal,2.0NRT,290,5,D`);
  }
  const presence = presenceFromRows(parseFirmsCsv([HEADER, ...lines].join("\n")));
  // Days D - 3 and D start or end outside the file at some longitude, so they are dropped.
  expect([...presence.keys()]).toEqual([D - 2, D - 1]);
  // Every detection sits on one point, so one sub-cell holds the day's 24.
  expect(presence.get(D - 2)?.get(subcellOf(-9.5, 25.5))).toBe(24);
  expect(presence.get(D - 1)?.get(subcellOf(-9.5, 25.5))).toBe(24);
  expect(cellOfSubcell(subcellOf(-9.5, 25.5))).toBe(B);
});

test("sub-cells tile each 1 degree cell and map back to it by integer division", () => {
  // Every fixture row lands in the same cell as the plain floor definition.
  for (const r of parseFirmsCsv(SAMPLE)) {
    expect(cellKeyOf(r.lat, r.lon)).toBe(`${Math.floor(r.lat)},${Math.floor(r.lon)}`);
    expect(cellOfSubcell(subcellOf(r.lat, r.lon))).toBe(cellKeyOf(r.lat, r.lon));
  }
  expect(config.detectors.fireGrowth.persistenceSubcellsPerDeg).toBe(50);
  // 0.02 degree sub-cells: 0.02 apart in longitude is the next sub-cell, 0.01 apart is not.
  expect(subcellOf(10.001, 20.021)).toBe(subcellOf(10.001, 20.001) + 1);
  expect(subcellOf(10.001, 20.011)).toBe(subcellOf(10.001, 20.001));
  expect(subcellOf(-90, -180)).toBe(0);
  // Longitude 180 joins the last column of its row rather than wrapping.
  expect(cellOfSubcell(subcellOf(45.5, 180))).toBe("45,179");
  expect(cellKeyOf(-0.01, -0.01)).toBe("-1,-1");
  expect(cellKeyOf(0, 0)).toBe("0,0");
});

test("masked sub-cells are left out of the day counts and the evidence alike", async () => {
  const db = await freshDb();
  await ingestSample(db);
  const flare = subcellOf(34.14, -118.21);
  const mask = new Set([flare]);
  expect((await loadFireDayCounts(db, D, NO_MASK)).counts.get(A)).toBe(6);
  expect((await loadFireDayCounts(db, D, mask)).counts.get(A)).toBe(5);
  // Other cells are untouched.
  expect((await loadFireDayCounts(db, D, mask)).counts.get(B)).toBe(7);

  const ev = await materializeCellDay(db, A, D, T2, mask);
  expect(ev.facts.count?.value).toBe(5);
  expect(ev.meta).toMatchObject({ persistentLeftOut: 1, subcellsPerDeg: 50 });
  expect(ev.raw).not.toContain(line("34.14,-118.21"));
  // A different mask is a different version of the same cell-day record.
  const plain = await materializeCellDay(db, A, D, T2, NO_MASK);
  expect(plain.recordKey).toBe(ev.recordKey);
  expect(plain.id).not.toBe(ev.id);
});

// fireGrowthDue end to end: a flare heats one point every day, a fire spreads over new points.
const E = Date.UTC(2026, 8, 10) / MS_PER_DAY; // day 1 of the scored pair, 2026-09-10
const FIRE = "10,20";
const FLARE = "10,30";

function firmsLine(
  lat: number,
  lon: number,
  dayKey: number,
  hour: number,
  sat: string,
  conf = "nominal",
) {
  const iso = new Date(dayKey * MS_PER_DAY + hour * MS_PER_HOUR).toISOString();
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 13) + iso.slice(14, 16);
  return `${lat.toFixed(3)},${lon.toFixed(3)},330.0,0.4,0.4,${date},${time},${sat},${conf},2.0NRT,290,5,D`;
}

/** n points spread over a square, 0.021 degree apart (every point in its own sub-cell). */
function spread(n: number, lat0: number, lon0: number): Array<[number, number]> {
  const side = Math.ceil(Math.sqrt(n));
  return Array.from({ length: n }, (_, i) => [
    lat0 + Math.floor(i / side) * 0.021,
    lon0 + (i % side) * 0.021,
  ]);
}

/** Half of the points to each satellite, all at 12:00 UTC on the day's own date. */
function pass(points: Array<[number, number]>, dayKey: number): Record<string, string[]> {
  return {
    N20: points
      .filter((_, i) => i % 2 === 0)
      .map(([la, lo]) => firmsLine(la, lo, dayKey, 12, "N20")),
    N21: points
      .filter((_, i) => i % 2 === 1)
      .map(([la, lo]) => firmsLine(la, lo, dayKey, 12, "N21")),
  };
}

function growthFiles(withHistory: boolean): Record<string, Served> {
  const day: Record<string, string[]> = { N20: [], N21: [] };
  const add = (lines: Record<string, string[]>) => {
    for (const sat of ["N20", "N21"]) day[sat]!.push(...(lines[sat] ?? []));
  };
  add(pass(spread(100, 10.05, 20.05), E - 1)); // the fire on day 0
  add(pass(spread(250, 10.5, 20.5), E)); // and on day 1: up 150%
  add(pass(Array<[number, number]>(120).fill([10.5, 30.5]), E - 1)); // the flare on day 0
  add(pass(Array<[number, number]>(300).fill([10.5, 30.5]), E)); // and day 1, also up 150%
  // A low-confidence row on each edge date so every date the pair touches has a batch.
  for (const sat of ["N20", "N21"]) {
    day[sat]!.push(
      firmsLine(-30, -60, E - 2, 12, sat, "low"),
      firmsLine(-30, -60, E + 1, 12, sat, "low"),
    );
  }
  const served: Record<string, Served> = {
    [N20_URL]: { lastModified: LM1, body: [HEADER, ...day.N20!].join("\n") },
    [N21_URL]: { lastModified: LM_N21, body: [HEADER, ...day.N21!].join("\n") },
  };
  if (withHistory) {
    // The 7-day files: the flare every hour from E - 9 00:00 to E - 2 23:00 UTC, which covers
    // local solar days E - 8 to E - 3 whole at every longitude.
    for (const sat of ["N20", "N21"] as const) {
      const lines = Array.from({ length: 8 * 24 }, (_, h) => firmsLine(10.5, 30.5, E - 9, h, sat));
      served[sevenDayUrl(sat)] = { lastModified: LM1, body: [HEADER, ...lines].join("\n") };
    }
  }
  return served;
}

test("fireGrowthDue keeps a spreading fire and masks a flare that grew just as much", async () => {
  const db = await freshDb();
  const fetchImpl = fakeFetch(growthFiles(true));
  const start = (E - 2) * MS_PER_DAY + 23 * MS_PER_HOUR;
  expect((await bootstrapPresence(db, { now: start, fetchImpl })).status).toBe("ok");
  expect((await runFirms(db, { now: start + MS_PER_HOUR, fetchImpl })).status).toBe("ok");

  // Unmasked, both cells grew 150%.
  const raw0 = await loadFireDayCounts(db, E - 1, NO_MASK);
  expect([raw0.counts.get(FIRE), raw0.counts.get(FLARE)]).toEqual([100, 120]);
  const mask = persistentCells(await presenceHistory(db, E + 1, 30), [E - 1, E]);
  expect(mask?.has(subcellOf(10.5, 30.5))).toBe(true);
  expect((await loadFireDayCounts(db, E - 1, mask ?? NO_MASK)).counts.get(FLARE)).toBeUndefined();

  // Day 1 is over everywhere at 00:00 UTC two dates later (18:00 at -180 plus the 6 h margin).
  const ready = (E + 2) * MS_PER_DAY;
  expect(await fireGrowthDue(db, ready - 1)).toEqual({
    results: [],
    scored: 0,
    waiting: 0,
    mismatched: 0,
  });

  const run = await fireGrowthDue(db, ready);
  expect(run.results).toHaveLength(1);
  expect(run).toMatchObject({ scored: 1, waiting: 0, mismatched: 0 });
  const { detection, members } = run.results[0]!;
  const text = Object.fromEntries(Object.entries(detection.facts).map(([k, f]) => [k, f.text]));
  expect(text).toMatchObject({
    cell: FIRE,
    count_day0: "100",
    count_day1: "250",
    growth_pct: "150",
  });
  const evidence = await getEvents(db, members);
  expect(evidence.map((e) => [e.kind, e.facts.count?.value, e.meta?.persistentLeftOut])).toEqual([
    ["fire_cell_day", 100, 0],
    ["fire_cell_day", 250, 0],
  ]);

  // A rerun on the same data gives the same detection and stores no new evidence.
  const again = await fireGrowthDue(db, ready);
  expect(again.results.map((r) => r.detection.id)).toEqual([detection.id]);
  expect(await listEvents(db, { kinds: ["fire_cell_day"] })).toHaveLength(2);
});

test("fireGrowthDue does not score a pair while the persistence history is too short", async () => {
  const db = await freshDb();
  const fetchImpl = fakeFetch(growthFiles(false));
  await runFirms(db, { now: (E - 1) * MS_PER_DAY, fetchImpl });
  const run = await fireGrowthDue(db, (E + 2) * MS_PER_DAY);
  expect(run).toEqual({ results: [], scored: 0, waiting: 1, mismatched: 0 });
});
