// Fire growth backtest on the FIRMS 7-day files (docs/plan.md 3c: "Phase 2 backtests on the 7-day
// files and must show at least one real growth cell surviving the mask"). Runs the production path
// on an in-memory database: bootstrapPresence fills fire_presence from both satellites' 7-day
// files, then every consecutive pair of local solar days is counted with loadFireDayCounts and
// scored with detectFireGrowth under each mask.
//
// Masks (persistence per 0.02 degree sub-cell, persistenceFraction of the other days):
// - causal: only the days before the pair, as the worker would have seen it (production).
// - leave-two-out: every other day in the files, including later ones. Flares, refineries, and
//   volcanoes do not move, so this is a fair calibration view; it is not what production runs.
//   Reported at the production minimum of days and over the days the files hold.
//
//   node scripts/backtest-fires.ts             downloads each 7-day file once into data/cache/firms/
//   node scripts/backtest-fires.ts --refresh   downloads them again
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "../argus.config.ts";
import { migrate, openDb } from "../src/db/client.ts";
import { detectFireGrowth } from "../src/detectors/fire-growth.ts";
import { persistentCells } from "../src/detectors/fire-mask.ts";
import type { FireDayCounts, FireGrowthFinding } from "../src/detectors/types.ts";
import {
  bootstrapPresence,
  loadFireDayCounts,
  presenceHistory,
  solarDayLabel,
} from "../src/ingest/sources/firms.ts";
import type { FetchImpl } from "../src/ingest/types.ts";

const ROOT = join(import.meta.dirname, "..");
const CACHE = join(ROOT, "data", "cache", "firms");
const OUT = join(ROOT, "data", "backtest-fires.json");
const refresh = process.argv.includes("--refresh");
const cfg = config.detectors.fireGrowth;
const NO_MASK: ReadonlySet<number> = new Set();

/** fetch with a file cache: each URL is downloaded once unless --refresh is passed. */
const cachedFetch: FetchImpl = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const file = join(CACHE, basename(new URL(url).pathname));
  if (!refresh && existsSync(file)) return new Response(readFileSync(file));
  const res = await fetch(input, init);
  if (!res.ok) return res;
  const body = Buffer.from(await res.arrayBuffer());
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, body);
  console.log(`downloaded ${basename(file)}: ${body.length} bytes`);
  return new Response(body, { status: res.status, headers: res.headers });
};

const db = await openDb(":memory:");
await migrate(db);
const boot = await bootstrapPresence(db, { now: Date.now(), fetchImpl: cachedFetch });
console.log(`bootstrap: ${boot.status}, ${boot.fetched} rows read. ${boot.message ?? ""}`);
if (boot.status !== "ok") process.exit(1);

const dayRows = await db.execute(
  "SELECT day_key, COUNT(*) AS sats FROM fire_presence GROUP BY day_key ORDER BY day_key",
);
const days = dayRows.rows.map((r) => ({ dayKey: Number(r.day_key), sats: Number(r.sats) }));
console.log(
  `presence days: ${days.map((d) => `${solarDayLabel(d.dayKey)} (${d.sats} satellites)`).join(", ")}`,
);
const lastDay = days[days.length - 1]?.dayKey ?? 0;
const allHistory = await presenceHistory(db, lastDay + 1, config.retention.firePresenceDays);
const otherDays = days.length - 2;

/** Leave-two-out over every day in the files; minDays lowers the history minimum when set. */
function leaveTwoOut(dayKey: number, minDays?: number): Set<number> | null {
  return persistentCells(allHistory, [dayKey, dayKey + 1], {
    ...cfg,
    persistenceMinDays: minDays ?? cfg.persistenceMinDays,
  });
}

function total(c: FireDayCounts): number {
  let n = 0;
  for (const v of c.counts.values()) n += v;
  return n;
}

const cellsOf = (fs: FireGrowthFinding[]) => fs.map((f) => f.cellKey);

interface MaskResult {
  name: string;
  state: string;
  findings: number | null;
  day0LeftOut: string;
  removed: string[];
  added: string[];
}
interface PairResult {
  day0: string;
  day1: string;
  scoredCells: number;
  noMaskFindings: number;
  masks: MaskResult[];
  kept: Array<{ cell: string; count0: number; count1: number; growthPct: number }>;
}

const pairs: PairResult[] = [];
const widest = new Map<number, [FireDayCounts, FireDayCounts]>();
for (const d of days) {
  if (!days.some((x) => x.dayKey === d.dayKey + 1)) continue;
  const raw0 = await loadFireDayCounts(db, d.dayKey, NO_MASK);
  const raw1 = await loadFireDayCounts(db, d.dayKey + 1, NO_MASK);
  const unmasked = detectFireGrowth(raw0, raw1);
  const causalHistory = await presenceHistory(db, d.dayKey + 2, config.retention.firePresenceDays);
  const masks: Array<{ name: string; cells: Set<number> | null }> = [
    {
      name: "causal (production)",
      cells: persistentCells(causalHistory, [d.dayKey, d.dayKey + 1]),
    },
    { name: `leave-two-out, ${cfg.persistenceMinDays}-day minimum`, cells: leaveTwoOut(d.dayKey) },
    {
      name: `leave-two-out, ${otherDays}-day history (below the production minimum)`,
      cells: leaveTwoOut(d.dayKey, otherDays),
    },
  ];
  const results: MaskResult[] = [];
  let kept: FireGrowthFinding[] = [];
  for (const m of masks) {
    if (m.cells === null) {
      results.push({
        name: m.name,
        state: "off",
        findings: null,
        day0LeftOut: "",
        removed: [],
        added: [],
      });
      continue;
    }
    const c0 = await loadFireDayCounts(db, d.dayKey, m.cells);
    const c1 = await loadFireDayCounts(db, d.dayKey + 1, m.cells);
    const found = detectFireGrowth(c0, c1);
    kept = found;
    widest.set(d.dayKey, [c0, c1]);
    results.push({
      name: m.name,
      state: `${m.cells.size} persistent sub-cells`,
      findings: found.length,
      day0LeftOut: `${total(raw0) - total(c0)} of ${total(raw0)} day-0 detections`,
      removed: cellsOf(unmasked).filter((c) => !cellsOf(found).includes(c)),
      added: cellsOf(found).filter((c) => !cellsOf(unmasked).includes(c)),
    });
  }
  pairs.push({
    day0: solarDayLabel(d.dayKey),
    day1: solarDayLabel(d.dayKey + 1),
    scoredCells: [...raw0.counts.values()].filter((n) => n >= cfg.minBaselineCount).length,
    noMaskFindings: unmasked.length,
    masks: results,
    kept: kept.slice(0, 5).map((f) => ({
      cell: f.cellKey,
      count0: f.count0,
      count1: f.count1,
      growthPct: f.growthPct,
    })),
  });
}

console.log(
  `\nthresholds: minBaselineCount ${cfg.minBaselineCount}, minGrowthPct ${cfg.minGrowthPct}, ` +
    `persistenceFraction ${cfg.persistenceFraction}, persistenceMinDays ${cfg.persistenceMinDays}, ` +
    `persistenceSubcellsPerDeg ${cfg.persistenceSubcellsPerDeg}`,
);
for (const p of pairs) {
  console.log(
    `\n${p.day0} to ${p.day1}: ${p.scoredCells} cells at or above the baseline, ` +
      `${p.noMaskFindings} findings with no mask`,
  );
  for (const m of p.masks) {
    if (m.findings === null) {
      console.log(`  mask ${m.name}: off`);
      continue;
    }
    console.log(
      `  mask ${m.name}: ${m.state}, left out ${m.day0LeftOut}, ${m.findings} findings` +
        `, removed ${m.removed.length ? m.removed.join(" and ") : "none"}` +
        (m.added.length ? `, added ${m.added.join(" and ")}` : ""),
    );
  }
  for (const t of p.kept) {
    console.log(`  kept: cell ${t.cell}: ${t.count0} then ${t.count1} (+${t.growthPct}%)`);
  }
}

// Sensitivity: findings per pair under the widest mask available, for nearby thresholds.
const grid: Array<{ minBaselineCount: number; minGrowthPct: number; findings: number[] }> = [];
for (const minBaselineCount of [50, 100, 200]) {
  for (const minGrowthPct of [50, 100, 200]) {
    const perPair = [...widest.values()].map(
      ([c0, c1]) => detectFireGrowth(c0, c1, { ...cfg, minBaselineCount, minGrowthPct }).length,
    );
    grid.push({ minBaselineCount, minGrowthPct, findings: perPair });
  }
}
console.log(`\nsensitivity (leave-two-out mask over ${otherDays} days), findings per pair:`);
for (const g of grid) {
  console.log(
    `  baseline ${g.minBaselineCount}, growth ${g.minGrowthPct}%: ${g.findings.join(", ")}`,
  );
}

writeFileSync(OUT, JSON.stringify({ bootstrap: boot, days, pairs, grid }, null, 2));
console.log(`\nwrote ${OUT}`);
