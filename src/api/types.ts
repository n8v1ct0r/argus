// The contract between the API routes and the UI. Routes return exactly these shapes.
import type { Facts, Kind, Source } from "../events/types.ts";

export type LayerId = "quakes" | "fires" | "flights" | "satellites" | "events";

/** GET /api/layers/{layer}?from=&to= */
export interface QuakeItem {
  id: string;
  lon: number;
  lat: number;
  /** facts.mag.text, copied exactly. */
  mag: string;
  magValue: number;
  occurredAt: number;
  /** True when a quake-cluster detection in the window cites it. */
  inFinding: boolean;
}

export interface FireCellItem {
  /** Cell key "floor(lat),floor(lon)". */
  id: string;
  lat: number;
  lon: number;
  count: number;
  inFinding: boolean;
}

export interface FlightItem {
  /** `${frameId}#${index}`; never an aircraft identifier. */
  id: string;
  frameId: string;
  lon: number;
  lat: number;
  altFt: number | null;
  trackDeg: number | null;
  t: number;
}

/** GET /api/layers/satellites?from=&to=&step= : SGP4 positions on a time grid (server-side). */
export interface SatelliteGrid {
  ids: string[];
  names: string[];
  times: number[];
  /**
   * positions[timeIndex][satIndex*3 .. +2] = lon, lat, heightMeters. NaN where SGP4 returned no
   * position (for example a decayed object). The client interpolates between grid times.
   */
  positions: number[][];
}

export interface NaturalEventItem {
  id: string;
  lon: number;
  lat: number;
  category: string;
  title: string;
  occurredAt: number;
  /** [west, south, east, north] when the event is an area. */
  bbox: [number, number, number, number] | null;
}

export type LayerPayload =
  | { layer: "quakes"; from: number; to: number; items: QuakeItem[] }
  | { layer: "fires"; from: number; to: number; items: FireCellItem[] }
  | { layer: "flights"; from: number; to: number; frameTimes: number[]; items: FlightItem[] }
  | { layer: "events"; from: number; to: number; items: NaturalEventItem[] };

/** GET /api/replay?from=&to= : the traces the drum strip draws. */
export interface ReplaySummary {
  from: number;
  to: number;
  quakes: Array<{ t: number; magValue: number; id: string; inFinding: boolean }>;
  /** Fire detections per 30-minute bin (by acquisition time). */
  fires: Array<{ binStart: number; count: number }>;
  /** Aircraft counted per stored layer frame, summed over areas. */
  flights: Array<{ t: number; count: number }>;
  events: Array<{ t: number; id: string }>;
  /** Stretches where a source was stale or failing. */
  gaps: Array<{ layer: LayerId; from: number; to: number; state: "stale" | "error" }>;
}

export interface BriefBullet {
  text: string;
  event_ids: string[];
}

/** GET /api/brief */
export interface BriefPayload {
  brief: {
    id: string;
    createdAt: number;
    windowStart: number;
    windowEnd: number;
    model: string;
    bullets: BriefBullet[];
    /** Numbers the checker verified across all bullets. */
    numbersChecked: number;
  } | null;
  /** Why there is no brief yet, in plain words, when brief is null. */
  reason?: string;
}

/** GET /api/events?ids=a,b : the citation panel. */
export interface CitationEvent {
  id: string;
  source: Source;
  kind: Kind;
  title: string;
  occurredAt: number;
  fetchedAt: number;
  lat: number | null;
  lon: number | null;
  bbox: [number, number, number, number] | null;
  facts: Facts;
  /** The stored record as text (bulk records trimmed, with a note). */
  record: string;
  recordNote: string | null;
  rawDigest: string;
  supersedes: string | null;
  /** Member event ids for detections and aggregates. */
  members: string[];
  /** Provider credit for this event's source. */
  credit: string;
}

export interface EventsPayload {
  events: CitationEvent[];
  missing: string[];
}

export type SourceState = "live" | "stale" | "error" | "off";

/** GET /api/status */
export interface StatusPayload {
  now: number;
  sources: Record<
    LayerId,
    { state: SourceState; lastOkAt: number | null; lastStatus: number | null }
  >;
}

/** POST /api/ask {question} */
export interface AskResponse {
  answer: { sentences: BriefBullet[]; numbersChecked: number } | null;
  /** Plain-words reason when there is no answer (rate limit, daily budget, checker failure). */
  error?: string;
  retryAfterSeconds?: number;
}
