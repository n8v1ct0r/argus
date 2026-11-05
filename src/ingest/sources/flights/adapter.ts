// The flights provider contract. adsb.lol is the only provider today (docs/plan.md 1e); the
// rest of the flights module only sees this interface, so a provider swap touches one file.

/** A circular polling area from argus.config.ts (a layer area or the detector area). */
export interface FlightArea {
  id: string;
  lat: number;
  lon: number;
  radiusNm: number;
}

export interface FlightFetchOk {
  ok: true;
  /** The time the response describes, in ms (upstream `now`). Sample times are relative to it. */
  now: number;
  /** Upstream aircraft records, unredacted. Never store or log these; pass them to redact.ts. */
  aircraft: unknown[];
  /** Local clock time when the request started (the time written to the fetch log). */
  requestedAt?: number;
}

export interface FlightFetchFailed {
  ok: false;
  status: number | null;
  message: string;
  /** True when no request was sent because the persisted backoff did not allow one yet. */
  skipped?: true;
}

export type FlightFetchResult = FlightFetchOk | FlightFetchFailed;

export interface FlightProvider {
  name: string;
  fetchArea(area: FlightArea, now: number): Promise<FlightFetchResult>;
}

/** Time source for request spacing, injected so tests run on a fake clock. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
