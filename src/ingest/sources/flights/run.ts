// Flights entry points for the ingest worker. Both go through the provider's serial queue, so
// a layer poll and a detector poll never overlap and always keep the configured spacing.
// Redaction happens here, before any event is built.
import { config } from "../../../../argus.config.ts";
import type { Db } from "../../../db/client.ts";
import { insertEvents } from "../../../db/queries.ts";
import type { FlightSample } from "../../../detectors/types.ts";
import { MS_PER_HOUR } from "../../../lib/time.ts";
import type { RunDeps, SourceRunResult } from "../../types.ts";
import type { FlightFetchFailed, FlightProvider } from "./adapter.ts";
import { buildLayerFrame } from "./frames.ts";
import { redactAll } from "./redact.ts";
import { aircraftId } from "./salt.ts";

const SOURCE = "flights";

export interface FlightsRunDeps extends RunDeps {
  provider: FlightProvider;
  /** Aircraft id function; defaults to the process-wide daily salt in salt.ts. */
  idFor?: (hex: string, t: number) => string;
}

export interface FlightsDetectorSampleResult extends SourceRunResult {
  /** Redacted samples of the detector area; empty when the poll failed or was skipped. */
  samples: FlightSample[];
}

/** Reference to the fetch_log row (source, hour_start) that counted a request. */
export function fetchLogRef(requestedAt: number): string {
  return `fetch_log:${SOURCE}:${Math.floor(requestedAt / MS_PER_HOUR) * MS_PER_HOUR}`;
}

function failed(
  areaId: string,
  res: FlightFetchFailed,
  fetched: number,
  inserted: number,
): SourceRunResult {
  return {
    source: SOURCE,
    fetched,
    inserted,
    status: res.skipped ? "skipped_backoff" : "error",
    message: `${areaId}: ${res.message}`,
  };
}

/**
 * Polls every layer area once, one after another, and stores one flight_frame per area. Stops
 * at the first failure: after a 4xx the provider's backoff blocks the remaining areas anyway.
 */
export async function runFlightsLayer(db: Db, deps: FlightsRunDeps): Promise<SourceRunResult> {
  const idFor = deps.idFor ?? aircraftId;
  let fetched = 0;
  let inserted = 0;
  for (const area of config.sources.flights.layerAreas) {
    const res = await deps.provider.fetchArea(area, deps.now);
    if (!res.ok) return failed(area.id, res, fetched, inserted);
    fetched += res.aircraft.length;
    const samples = redactAll(res.aircraft, res.now, idFor);
    const requestedAt = res.requestedAt ?? res.now;
    const frame = buildLayerFrame(area.id, samples, res.now, fetchLogRef(requestedAt));
    inserted += await insertEvents(db, [frame], "ingest", requestedAt);
  }
  return { source: SOURCE, fetched, inserted, status: "ok" };
}

/**
 * Polls the detector area once and returns its redacted samples. Nothing is stored here: the
 * worker collects samples for config.cadence.flightsDetectorBatchSeconds and stores them with
 * buildDetectorBatch().
 */
export async function runFlightsDetectorSample(
  db: Db,
  deps: FlightsRunDeps,
): Promise<FlightsDetectorSampleResult> {
  const area = config.sources.flights.detectorArea;
  const res = await deps.provider.fetchArea(area, deps.now);
  if (!res.ok) return { ...failed(area.id, res, 0, 0), samples: [] };
  const samples = redactAll(res.aircraft, res.now, deps.idFor ?? aircraftId);
  return { source: SOURCE, fetched: res.aircraft.length, inserted: 0, status: "ok", samples };
}
