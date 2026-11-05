import { expect, test } from "@playwright/test";
import { config } from "../../argus.config.ts";
import { migrate, openDb } from "../../src/db/client.ts";
import { insertEvents } from "../../src/db/queries.ts";
import { buildFireGrowthDetection, detectFireGrowth } from "../../src/detectors/fire-growth.ts";
import { persistentCells } from "../../src/detectors/fire-mask.ts";
import type { FireDayCounts } from "../../src/detectors/types.ts";
import { sha256Hex } from "../../src/lib/digest.ts";
import { dayKeyLabel, localSolarDayKey, utcDay } from "../../src/lib/time.ts";

const cfg = config.detectors.fireGrowth;
const BOTH = ["N20", "N21"];
// A local solar day key for a date in September 2026 at the test cells' longitude.
const DAY0 = localSolarDayKey(Date.UTC(2026, 8, 21, 20, 0, 0), -119.5);
const DAY1 = DAY0 + 1;

function day(dayKey: number, counts: Record<string, number>, satellites = BOTH): FireDayCounts {
  return { dayKey, satellites, counts: new Map(Object.entries(counts)) };
}

test("growth thresholds compare exact integers at every edge", () => {
  const findings = detectFireGrowth(
    day(DAY0, {
      "34,-120": 100, // exactly double on the exact baseline: passes
      "35,-120": 100, // one below double: fails
      "36,-120": 99, // one below the baseline, even at triple: fails
      "37,-120": 101, // 202 is double: passes
      "38,-120": 101, // 201 is one below double: fails
      "39,-120": 150, // 301: growth 100.67% shown as 100
    }),
    day(DAY1, {
      "34,-120": 200,
      "35,-120": 199,
      "36,-120": 297,
      "37,-120": 202,
      "38,-120": 201,
      "39,-120": 301,
      "40,-120": 500, // no baseline on day 0
    }),
  );
  expect(findings.map((f) => [f.cellKey, f.count0, f.count1, f.growthPct])).toEqual([
    ["34,-120", 100, 200, 100],
    ["37,-120", 101, 202, 100],
    ["39,-120", 150, 301, 100],
  ]);
  expect(findings[0]).toMatchObject({ day0: DAY0, day1: DAY1, satellites: BOTH });
});

test("both days need the same satellites, all configured satellites, and to be consecutive", () => {
  const d0 = { "34,-120": 100 };
  const d1 = { "34,-120": 300 };
  expect(detectFireGrowth(day(DAY0, d0), day(DAY1, d1))).toHaveLength(1);
  // Listing order does not matter.
  expect(detectFireGrowth(day(DAY0, d0, ["N21", "N20"]), day(DAY1, d1))).toHaveLength(1);
  expect(detectFireGrowth(day(DAY0, d0), day(DAY1, d1, ["N20"]))).toEqual([]);
  expect(detectFireGrowth(day(DAY0, d0, ["N20"]), day(DAY1, d1, ["N20"]))).toEqual([]);
  expect(detectFireGrowth(day(DAY0, d0), day(DAY1 + 1, d1))).toEqual([]);
});

test("findings come largest growth first", () => {
  const d0 = day(DAY0, { "34,-120": 100, "29,48": 400 });
  // Growth 150% and 200%. Masking persistent sub-cells happens before counting (firms.spec.ts).
  const d1 = day(DAY1, { "34,-120": 250, "29,48": 1200 });
  expect(detectFireGrowth(d0, d1).map((f) => f.cellKey)).toEqual(["29,48", "34,-120"]);
});

test("the persistence mask is off until enough usable days exist", () => {
  const history = [1, 2, 3, 4, 5, 6].map((k) => ({ dayKey: k, cells: new Set(["29,48"]) }));
  // Four days of history: too short, the detector stays off.
  expect(persistentCells(history.slice(0, 4), [])).toBeNull();
  // Six days minus the two scored days is still four.
  expect(persistentCells(history, [5, 6])).toBeNull();
  expect(persistentCells(history.slice(0, 5), [])).toEqual(new Set(["29,48"]));
});

test("a cell is persistent at persistenceFraction of usable days, counted once per day", () => {
  expect(cfg.persistenceFraction).toBe(0.6);
  const cellsByDay: string[][] = [
    ["flare", "twice", "per-sat"],
    ["flare", "twice", "per-sat"],
    ["flare"],
    [],
    [],
  ];
  // One row per day and satellite, as fire_presence stores them.
  const history = cellsByDay.flatMap((cells, i) => [
    { dayKey: 10 + i, cells: new Set(cells) },
    { dayKey: 10 + i, cells: new Set(cells.filter((c) => c === "per-sat")) },
  ]);
  // flare: 3 of 5 days (exactly 0.6); twice and per-sat: 2 of 5.
  expect(persistentCells(history, [])).toEqual(new Set(["flare"]));

  const ten = Array.from({ length: 10 }, (_, i) => ({
    dayKey: i,
    cells: new Set([...(i < 6 ? ["six"] : []), ...(i < 5 ? ["five"] : [])]),
  }));
  expect(persistentCells(ten, [])).toEqual(new Set(["six"]));
});

test("a fire growth detection cites both cell days with code-built facts", async () => {
  const [finding] = detectFireGrowth(day(DAY0, { "34,-120": 120 }), day(DAY1, { "34,-120": 300 }));
  expect(finding).toBeDefined();
  const lon = -119.5;
  const labels: [string, string] = [dayKeyLabel(DAY0), dayKeyLabel(DAY1)];
  const evidence: [string, string] = [
    `firms:cell-day:34_-120:${DAY0}@f1`,
    `firms:cell-day:34_-120:${DAY1}@f2`,
  ];
  const fetchedAt = Date.UTC(2026, 8, 23, 18, 0, 0);
  const { detection: d, members } = buildFireGrowthDetection(finding!, evidence, labels, fetchedAt);

  expect(members).toEqual(evidence);
  expect(d.id).toMatch(new RegExp(`^argus:fire-growth:34_-120:${DAY1}@[0-9a-f]{12}$`));
  expect(d.recordKey).toBe(`argus:fire-growth:34_-120:${DAY1}`);
  expect(d.kind).toBe("detection");
  expect(d.fetchedAt).toBe(fetchedAt);
  expect(d.title).toBe("Heat detections up 150% in cell 34,-120");
  expect(d.title).not.toMatch(/[–—]/);

  const text = Object.fromEntries(Object.entries(d.facts).map(([k, f]) => [k, f.text]));
  expect(text).toEqual({
    cell: "34,-120",
    count_day0: "120",
    count_day1: "300",
    growth_pct: "150",
    date_day0: labels[0],
    date_day1: labels[1],
    satellites: "N20, N21",
  });
  expect(d.meta).toMatchObject({ detector: "fire-growth", day0: DAY0, day1: DAY1 });

  // Cell centre and box, and a time inside the day-1 bin that dayKeyLabel dates.
  expect([d.lat, d.lon]).toEqual([34.5, -119.5]);
  expect(d.bbox).toEqual({ minLat: 34, minLon: -120, maxLat: 35, maxLon: -119 });
  expect(localSolarDayKey(d.occurredAt, lon)).toBe(DAY1);
  expect(utcDay(d.occurredAt)).toBe(labels[1]);
  expect(d.rawDigest).toBe(sha256Hex(d.raw ?? ""));

  const db = await openDb(":memory:");
  await migrate(db);
  expect(await insertEvents(db, [d], "ingest", fetchedAt)).toBe(1);
});
