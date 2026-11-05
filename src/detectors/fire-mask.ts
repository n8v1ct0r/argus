// Persistence mask for fire growth (docs/plan.md 3c). Gas flares, refineries, and volcanoes heat
// the same spot on most days; a key (in production a 0.02 degree sub-cell, see firms.ts) is
// persistent when it had detections on at least persistenceFraction of the usable history days.
// The two scored days are excluded, and the mask (and with it the fire growth detector) stays off
// until persistenceMinDays usable days exist.
import { config } from "../../argus.config.ts";

export interface FireMaskConfig {
  persistenceFraction: number;
  persistenceMinDays: number;
}

/** Returns the persistent keys, or null when history is too short to judge (detector off). */
export function persistentCells<K>(
  history: ReadonlyArray<{ dayKey: number; cells: ReadonlySet<K> }>,
  excludeDayKeys: readonly number[],
  cfg: FireMaskConfig = config.detectors.fireGrowth,
): Set<K> | null {
  const excluded = new Set(excludeDayKeys);
  // fire_presence holds one row per day and satellite; a cell counts once per day.
  const days = new Map<number, Set<K>>();
  for (const { dayKey, cells } of history) {
    if (excluded.has(dayKey)) continue;
    const union = days.get(dayKey) ?? new Set<K>();
    for (const cell of cells) union.add(cell);
    days.set(dayKey, union);
  }
  if (days.size < cfg.persistenceMinDays) return null;

  const presentDays = new Map<K, number>();
  for (const cells of days.values()) {
    for (const cell of cells) presentDays.set(cell, (presentDays.get(cell) ?? 0) + 1);
  }
  const persistent = new Set<K>();
  for (const [cell, present] of presentDays) {
    // present / days is the nearest double to the exact ratio, so an exact tie (3 of 5 at 0.6)
    // compares equal instead of falling to float error.
    if (present / days.size >= cfg.persistenceFraction) persistent.add(cell);
  }
  return persistent;
}
