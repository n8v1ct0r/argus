// The time span each recorded layer covers, read from the snapshot's replay summary, and the
// labels the static deploy shows for them. Layers were captured over different spans: quakes,
// fires, and natural events cover the whole replay window, flights only the frames the ingest
// stored. No label states a span the data does not hold.
import type { LayerId, ReplaySummary } from "../api/types.ts";

export interface Span {
  from: number;
  to: number;
}

/** Each layer's span in the recording; null when the layer holds no data. */
export function layerSpans(replay: ReplaySummary): Record<LayerId, Span | null> {
  const window: Span = { from: replay.from, to: replay.to };
  const frames = replay.flights.map((f) => f.t);
  return {
    quakes: window,
    fires: window,
    events: window,
    // Satellite positions are computed for every replay time from the stored orbits.
    satellites: window,
    flights: frames.length ? { from: Math.min(...frames), to: Math.max(...frames) } : null,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function day(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

/** "Nov 4 16:40 to Nov 5 16:40 UTC", or "Nov 5 14:59 to 16:39 UTC" within one UTC day. */
export function spanLabel(s: Span): string {
  const sameDay = day(s.from) === day(s.to);
  return `${day(s.from)} ${clock(s.from)} to ${sameDay ? "" : `${day(s.to)} `}${clock(s.to)} UTC`;
}

/** The breadcrumb: "Recorded Nov 4 to 5", "Recorded Oct 31 to Nov 1", or "Recorded Nov 5". */
export function crumbLabel(s: Span | null): string {
  if (!s) return "Recorded";
  const a = new Date(s.from);
  const b = new Date(s.to);
  if (day(s.from) === day(s.to)) return `Recorded ${day(s.from)}`;
  const end = a.getUTCMonth() === b.getUTCMonth() ? `${b.getUTCDate()}` : day(s.to);
  return `Recorded ${day(s.from)} to ${end}`;
}

/** The tooltip on a layer's RECORDED badge. */
export function recordedTitle(id: LayerId, s: Span | null): string {
  if (!s) return "Recorded. No data in this recording.";
  return id === "satellites"
    ? `Positions computed from stored orbits for ${spanLabel(s)}.`
    : `Recorded ${spanLabel(s)}.`;
}

/** True when a layer covers less than the replay window, so the rail says so in plain text. */
export function isPartial(s: Span | null, replay: ReplaySummary): boolean {
  return s !== null && (s.from > replay.from || s.to < replay.to);
}
