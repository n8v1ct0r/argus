// Fire growth detector (docs/plan.md 3c): the heat detection count in one cell rises by at least
// minGrowthPct from one local solar day to the next. Integer math only, so a threshold edge is
// never decided by float error. The counts arrive with persistent heat sources (flares,
// refineries, volcanoes) already left out, per 0.02 degree sub-cell (firms.ts loadFireDayCounts).
import { config } from "../../argus.config.ts";
import { count, label } from "../events/facts.ts";
import type { EventRecord, Facts } from "../events/types.ts";
import { canonicalJson, sha256Hex } from "../lib/digest.ts";
import { recordKeyOf, versionId } from "../lib/ids.ts";
import type { DetectionResult, FireDayCounts, FireGrowthFinding } from "./types.ts";
import { DIGEST_ID_HEX_CHARS, HALF, PERCENT } from "./units.ts";
import { solarNoonMs } from "../lib/time.ts";

export interface FireGrowthConfig {
  cellDeg: number;
  minBaselineCount: number;
  minGrowthPct: number;
  satellites: readonly string[];
}

export function detectFireGrowth(
  day0: FireDayCounts,
  day1: FireDayCounts,
  cfg: FireGrowthConfig = config.detectors.fireGrowth,
): FireGrowthFinding[] {
  if (day1.dayKey !== day0.dayKey + 1) return [];
  const satellites = sortedUnique(day0.satellites);
  if (satellites.join() !== sortedUnique(day1.satellites).join()) return [];
  if (!cfg.satellites.every((s) => satellites.includes(s))) return [];

  const findings: FireGrowthFinding[] = [];
  for (const [cellKey, count0] of day0.counts) {
    if (count0 < cfg.minBaselineCount || count0 <= 0) continue;
    const count1 = day1.counts.get(cellKey) ?? 0;
    if (count1 * PERCENT < count0 * (PERCENT + cfg.minGrowthPct)) continue;
    findings.push({
      cellKey,
      day0: day0.dayKey,
      day1: day1.dayKey,
      count0,
      count1,
      growthPct: Math.floor(((count1 - count0) * PERCENT) / count0),
      satellites,
    });
  }
  // Largest growth first; the cell key breaks ties so the order is deterministic.
  return findings.sort(
    (a, b) => b.growthPct - a.growthPct || a.cellKey.localeCompare(b.cellKey, "en"),
  );
}

/**
 * Builds the citable detection for a finding. evidenceIds are the version ids of the two
 * fire_cell_day events (day0, day1) that hold the raw CSV lines; dateLabels are their dates.
 */
export function buildFireGrowthDetection(
  f: FireGrowthFinding,
  evidenceIds: [string, string],
  dateLabels: [string, string],
  fetchedAt: number,
  cfg: FireGrowthConfig = config.detectors.fireGrowth,
): DetectionResult {
  const [minLat, minLon] = parseCellKey(f.cellKey);
  const lat = minLat + cfg.cellDeg * HALF;
  const lon = minLon + cfg.cellDeg * HALF;
  const thresholds = { ...cfg, satellites: [...cfg.satellites] };
  const digest = sha256Hex(canonicalJson({ finding: f, evidence: evidenceIds, thresholds }));
  // Event ids end at a comma in brief text (EVENT_ID_PATTERN), so the id spells the cell with "_".
  const nativeId = `fire-growth:${f.cellKey.split(",").join("_")}:${f.day1}`;

  const facts: Facts = {
    cell: label(f.cellKey),
    count_day0: count(f.count0),
    count_day1: count(f.count1),
    growth_pct: count(f.growthPct, "%"),
    date_day0: label(dateLabels[0]),
    date_day1: label(dateLabels[1]),
    satellites: label(f.satellites.join(", ")),
  };
  const raw = JSON.stringify({
    cell: f.cellKey,
    day0: f.day0,
    day1: f.day1,
    count0: f.count0,
    count1: f.count1,
    satellites: f.satellites,
    evidence: evidenceIds,
  });

  const detection: EventRecord = {
    id: versionId("argus", nativeId, digest.slice(0, DIGEST_ID_HEX_CHARS)),
    recordKey: recordKeyOf("argus", nativeId),
    source: "argus",
    kind: "detection",
    occurredAt: solarNoonMs(f.day1, lon),
    fetchedAt,
    sourceUpdatedAt: null,
    lat,
    lon,
    bbox: { minLat, minLon, maxLat: minLat + cfg.cellDeg, maxLon: minLon + cfg.cellDeg },
    title: `Heat detections up ${f.growthPct}% in cell ${f.cellKey}`,
    facts,
    meta: { detector: "fire-growth", thresholds, day0: f.day0, day1: f.day1 },
    raw,
    rawGz: null,
    rawDigest: sha256Hex(raw),
    fetchId: null,
    supersedes: null,
  };
  return { detection, members: [...evidenceIds] };
}

function sortedUnique(xs: readonly string[]): string[] {
  return [...new Set(xs)].sort();
}

/** "floor(lat),floor(lon)" to the cell's south-west corner in degrees. */
function parseCellKey(cellKey: string): [number, number] {
  const [latText, lonText, ...rest] = cellKey.split(",");
  const lat = Number(latText);
  const lon = Number(lonText);
  if (!latText || !lonText || rest.length || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(`Invalid fire cell key: ${cellKey}`);
  }
  return [lat, lon];
}
