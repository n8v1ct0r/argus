// The one event shape (docs/plan.md section 2). Every layer record, detector finding, and
// Ask Argus count is an EventRecord, and every row is an immutable version.

export type Source = "usgs" | "celestrak" | "eonet" | "firms" | "flights" | "argus";

export type Kind =
  | "earthquake"
  | "satellite_elements"
  | "natural_event"
  | "fire_batch"
  | "fire_cell_day"
  | "flight_frame"
  | "aircraft_track"
  | "detection"
  | "aggregate";

/**
 * A citable number or string. `text` is the exact display string: the model may copy it, the
 * checker compares against it, and the citation panel shows it. Only code builds `text`.
 */
export interface Fact {
  value: number | string | boolean | null;
  text: string;
  unit?: string;
}

export type Facts = Record<string, Fact>;

export interface BBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/**
 * Ended records: when the newest version of a recordKey has meta.deleted === true (a USGS
 * tombstone or merge marker), the record is no longer live. Detectors and the API filter it out.
 */
export interface EventRecord {
  /** Immutable version id: `{source}:{native id}@{version}`. */
  id: string;
  /** Upstream identity without version. */
  recordKey: string;
  source: Source;
  kind: Kind;
  occurredAt: number;
  fetchedAt: number;
  sourceUpdatedAt: number | null;
  lat: number | null;
  lon: number | null;
  bbox: BBox | null;
  title: string;
  /** Citable facts only. */
  facts: Facts;
  /** Non-citable metadata: thresholds, filter versions, provider names. */
  meta: Record<string, unknown> | null;
  /** Exactly one of raw and rawGz is set. */
  raw: string | null;
  rawGz: Uint8Array | null;
  /** SHA-256 hex of the stored raw bytes. */
  rawDigest: string;
  fetchId: string | null;
  supersedes: string | null;
}
