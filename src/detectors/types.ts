// Contracts between the source adapters that produce detector inputs and the detectors.
import type { EventRecord } from "../events/types.ts";

/** A detection plus the version ids of the events it cites (stored as event_links). */
export interface DetectionResult {
  detection: EventRecord;
  members: string[];
}

/** Fire counts for one local solar day: cell key "floor(lat),floor(lon)" to count. */
export interface FireDayCounts {
  dayKey: number;
  /** Satellites that reported on this day (for example ["N20", "N21"]). */
  satellites: string[];
  /** Nominal plus high confidence detections per cell, summed over satellites. */
  counts: Map<string, number>;
}

/**
 * A fire-growth finding before its evidence is materialized. The FIRMS adapter turns each
 * (cell, day) into a fire_cell_day event holding the raw CSV lines; the worker then stores the
 * detection with those two events as members.
 */
export interface FireGrowthFinding {
  cellKey: string;
  day0: number;
  day1: number;
  count0: number;
  count1: number;
  /** floor((count1 - count0) / count0 * 100), computed by code. */
  growthPct: number;
  satellites: string[];
}

/** One redacted flight sample for the circling detector. */
export interface FlightSample {
  /** Keyed digest of the ICAO address; never the address itself. */
  aircraft: string;
  /** Position time in ms (now - seen_pos). */
  t: number;
  lat: number;
  lon: number;
  altFt: number | null;
  groundSpeedKt: number | null;
  trackDeg: number | null;
  onGround: boolean;
  /** Seconds since the position was received (seen_pos). */
  positionAgeS: number;
  /** ADS-B emitter category (A0 to D7), for example A3 for a large aircraft; not an identifier. */
  category?: string | null;
}
