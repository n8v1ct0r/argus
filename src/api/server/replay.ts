// GET /api/replay?from&to: the traces the drum strip draws, plus the stretches where a source
// was failing or stale.
//
// Gaps come from the hourly fetch log, so they have hour resolution:
//   error  an hour in the window with requests (or logged failures) but no OK fetch
//   stale  a stretch with no OK fetch while another source was fetching, longer than 3
//          cadences (so a stopped worker is not drawn as every source failing)
// The log keeps the last OK time of each hour, not the first, so a stale stretch runs from the
// last OK fetch to the start of the next hour that has one: it never overstates the stretch.
import type { Db } from "../../db/client.ts";
import { MS_PER_HOUR } from "../../lib/time.ts";
import type { LayerId, ReplaySummary } from "../types.ts";
import { fireBins } from "./fires.ts";
import { flightCounts } from "./flights.ts";
import { geometriesIn, naturalEventViews } from "./natural-events.ts";
import type { Window } from "./params.ts";
import { quakeItems } from "./quakes.ts";
import { LAYER_IDS, LAYER_SOURCES } from "./store.ts";

/** A source is stale after this many cadences without an OK fetch. */
export const STALE_CADENCES = 3;

type Gap = ReplaySummary["gaps"][number];
type Interval = [start: number, end: number];

interface HourActivity {
  /** Hours (start ms) with requests or logged failures. */
  active: Set<number>;
  /** Hour start to the last OK fetch in that hour. */
  ok: Map<number, number>;
}

const hourOf = (ms: number) => Math.floor(ms / MS_PER_HOUR) * MS_PER_HOUR;

/** Merges intervals that touch or overlap; input need not be sorted. */
function merge(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [as, ae] of a) {
    for (const [bs, be] of b) {
      const s = Math.max(as, bs);
      const e = Math.min(ae, be);
      if (e > s) out.push([s, e]);
    }
  }
  return merge(out);
}

function subtract(a: Interval[], b: Interval[]): Interval[] {
  let rest = a;
  for (const [bs, be] of b) {
    rest = rest.flatMap(([s, e]): Interval[] => {
      if (be <= s || bs >= e) return [[s, e]];
      const parts: Interval[] = [];
      if (bs > s) parts.push([s, bs]);
      if (be < e) parts.push([be, e]);
      return parts;
    });
  }
  return rest;
}

function hoursToIntervals(hours: Iterable<number>): Interval[] {
  return merge([...hours].map((h): Interval => [h, h + MS_PER_HOUR]));
}

const SOURCES: readonly string[] = LAYER_IDS.map((l) => LAYER_SOURCES[l].source);
const SOURCE_LIST = SOURCES.map(() => "?").join(",");

/** Hourly activity per layer source; both queries run on their table's (source, time) index. */
async function loadActivity(db: Db, from: number, to: number): Promise<Map<string, HourActivity>> {
  const byHour = new Map<string, HourActivity>();
  const entry = (source: string) => {
    let a = byHour.get(source);
    if (!a) byHour.set(source, (a = { active: new Set(), ok: new Map() }));
    return a;
  };
  const [log, errors] = await db.batch(
    [
      {
        sql: `SELECT source, hour_start, requests, last_ok_at FROM fetch_log
              WHERE source IN (${SOURCE_LIST}) AND hour_start >= ? AND hour_start <= ?`,
        args: [...SOURCES, hourOf(from), to],
      },
      {
        sql: `SELECT DISTINCT source, (at / ${MS_PER_HOUR}) * ${MS_PER_HOUR} AS hour_start
              FROM fetch_errors WHERE source IN (${SOURCE_LIST}) AND at >= ? AND at <= ?`,
        args: [...SOURCES, hourOf(from), to],
      },
    ],
    "read",
  );
  for (const r of log?.rows ?? []) {
    const a = entry(String(r.source));
    const hour = Number(r.hour_start);
    if (Number(r.requests) > 0) a.active.add(hour);
    if (r.last_ok_at !== null) a.ok.set(hour, Number(r.last_ok_at));
  }
  for (const r of errors?.rows ?? []) entry(String(r.source)).active.add(Number(r.hour_start));
  return byHour;
}

/** Each layer source's last OK fetch before the window's first hour. */
async function okBefore(db: Db, from: number): Promise<Map<string, number>> {
  const rs = await db.execute({
    sql: `SELECT source, MAX(last_ok_at) AS last_ok_at FROM fetch_log
          WHERE source IN (${SOURCE_LIST}) AND hour_start < ? AND last_ok_at IS NOT NULL
          GROUP BY source`,
    args: [...SOURCES, hourOf(from)],
  });
  return new Map(rs.rows.map((r) => [String(r.source), Number(r.last_ok_at)]));
}

/**
 * How far before the window the log is read, so a stretch that began earlier is measured whole:
 * the longest stale threshold of any source.
 */
const LOOKBACK_MS = Math.max(...LAYER_IDS.map((l) => LAYER_SOURCES[l].cadenceMs)) * STALE_CADENCES;

/** Error and stale stretches per layer, clipped to [from, min(to, now)]. */
export async function replayGaps(db: Db, w: Window, now: number): Promise<Gap[]> {
  const end = Math.min(w.to, now);
  if (end <= w.from) return [];
  const clip: Interval[] = [[w.from, end]];
  const since = hourOf(w.from - LOOKBACK_MS);
  const activity = await loadActivity(db, since, end);
  const before = await okBefore(db, since);
  const none: HourActivity = { active: new Set(), ok: new Map() };

  const gaps: Gap[] = [];
  for (const layer of LAYER_IDS) {
    const { source, cadenceMs } = LAYER_SOURCES[layer];
    const threshold = STALE_CADENCES * cadenceMs;
    const own = activity.get(source) ?? none;

    const errorHours = [...own.active].filter((h) => !own.ok.has(h));
    const errors = intersect(hoursToIntervals(errorHours), clip);

    const others = LAYER_IDS.filter((l) => l !== layer).flatMap((l) => [
      ...(activity.get(LAYER_SOURCES[l].source)?.active ?? []),
    ]);
    const othersFetching = hoursToIntervals(others);

    // Stretches without an OK fetch, then only the parts while another source was fetching,
    // and of those only the parts that are themselves longer than the threshold.
    const stretches: Interval[] = [];
    let lastOk = before.get(source) ?? -Infinity;
    for (const hour of [...own.ok.keys()].sort((a, b) => a - b)) {
      if (hour - lastOk > threshold) stretches.push([lastOk, hour]);
      lastOk = own.ok.get(hour) ?? hour;
    }
    if (end - lastOk > threshold) stretches.push([lastOk, end]);
    const watched = intersect(stretches, othersFetching).filter(([s, e]) => e - s > threshold);
    const stale = subtract(intersect(watched, clip), errors);

    for (const [from, to] of errors) gaps.push({ layer, from, to, state: "error" });
    for (const [from, to] of stale) gaps.push({ layer, from, to, state: "stale" });
  }
  const order = (l: LayerId) => LAYER_IDS.indexOf(l);
  return gaps.sort((a, b) => order(a.layer) - order(b.layer) || a.from - b.from);
}

export async function buildReplay(db: Db, p: Window & { now: number }): Promise<ReplaySummary> {
  const w: Window = { from: p.from, to: p.to };
  const quakes = (await quakeItems(db, w)).map((q) => ({
    t: q.occurredAt,
    magValue: q.magValue,
    id: q.id,
    inFinding: q.inFinding,
  }));
  const events: ReplaySummary["events"] = [];
  for (const view of await naturalEventViews(db, w.from)) {
    // The strip mirrors the events layer's default, which leaves wildfires to FIRMS.
    if (view.wildfire) continue;
    for (const g of geometriesIn(view, w)) events.push({ t: g.time, id: view.record.id });
  }
  events.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  return {
    from: w.from,
    to: w.to,
    quakes,
    fires: await fireBins(db, w),
    flights: await flightCounts(db, w),
    events,
    gaps: await replayGaps(db, w, p.now),
  };
}
