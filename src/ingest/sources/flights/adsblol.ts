// adsb.lol point queries (docs/plan.md 1e). One serial queue: never two requests in flight, and
// at least config.cadence.flightsMinSpacingSeconds between request starts. Rate limits are
// dynamic and unpublished, so any 4xx stops the source behind a persisted backoff.
// Only the point endpoint is ever built; adsbLolPointUrl() refuses anything else.
import { config } from "../../../../argus.config.ts";
import type { Db } from "../../../db/client.ts";
import { getBackoff, logFetchError, recordFailure, recordSuccess } from "../../../db/queries.ts";
import { sourceFetch } from "../../http.ts";
import type { FetchImpl } from "../../types.ts";
import {
  systemClock,
  type Clock,
  type FlightArea,
  type FlightFetchResult,
  type FlightProvider,
} from "./adapter.ts";

const SOURCE = "flights";
const MINUTE_MS = 60_000;
/** Any 4xx means Argus is doing something wrong: back off hard. */
export const CLIENT_ERROR_BACKOFF = { baseMs: 15 * MINUTE_MS, maxMs: 6 * 60 * MINUTE_MS };
/** 5xx, network errors, and unreadable bodies: the service is struggling, back off gently. */
export const SERVER_ERROR_BACKOFF = { baseMs: 5 * MINUTE_MS, maxMs: 60 * MINUTE_MS };
/** The point endpoint accepts a radius from 0 to 250 nm. */
const MAX_RADIUS_NM = 250;
const MIN_SPACING_MS = config.cadence.flightsMinSpacingSeconds * 1000;

/**
 * Builds `{baseUrl}/{lat}/{lon}/{radiusNm}` for the configured point endpoint. Throws on any
 * value that is not a plain in-range number, so no other path can be formed.
 */
export function adsbLolPointUrl(area: FlightArea): string {
  const { lat, lon, radiusNm } = area;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RangeError(`latitude out of range: ${lat}`);
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new RangeError(`longitude out of range: ${lon}`);
  }
  if (!Number.isFinite(radiusNm) || radiusNm <= 0 || radiusNm > MAX_RADIUS_NM) {
    throw new RangeError(`radius out of range: ${radiusNm}`);
  }
  const url = `${config.sources.flights.baseUrl}/${lat}/${lon}/${radiusNm}`;
  assertPointEndpoint(url);
  return url;
}

/** Allow-list check: the configured origin and point path followed by exactly 3 numbers. */
export function assertPointEndpoint(url: string): void {
  const base = new URL(config.sources.flights.baseUrl);
  const u = new URL(url);
  const prefix = `${base.pathname}/`;
  const rest = u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length).split("/") : [];
  const numeric = rest.length === 3 && rest.every((s) => /^-?\d+(\.\d+)?$/.test(s));
  if (u.origin !== base.origin || !numeric || u.search !== "" || u.hash !== "") {
    throw new Error(`refusing a flights request outside the point endpoint: ${u.pathname}`);
  }
}

export interface AdsbLolOptions {
  db: Db;
  fetchImpl?: FetchImpl;
  clock?: Clock;
  /** Spacing between request starts. Never below config.cadence.flightsMinSpacingSeconds. */
  minSpacingMs?: number;
  timeoutMs?: number;
}

/** Upstream `now` is epoch milliseconds; accept seconds too, and fall back to the local clock. */
function responseNowMs(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.round(value < 1e11 ? value * 1000 : value);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // The body is already consumed or closed; nothing to release.
  }
}

export function createAdsbLolProvider(opts: AdsbLolOptions): FlightProvider {
  const { db } = opts;
  const clock = opts.clock ?? systemClock;
  const minSpacingMs = Math.max(MIN_SPACING_MS, opts.minSpacingMs ?? 0);
  let lastStartAt: number | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  async function fail(
    status: number | null,
    backoff: { baseMs: number; maxMs: number },
    message: string,
  ): Promise<FlightFetchResult> {
    const state = await recordFailure(
      db,
      SOURCE,
      status,
      backoff.baseMs,
      backoff.maxMs,
      clock.now(),
    );
    return {
      ok: false,
      status,
      message: `${message}; paused until ${new Date(state.nextAllowedAt).toISOString()}`,
    };
  }

  async function request(area: FlightArea): Promise<FlightFetchResult> {
    const url = adsbLolPointUrl(area);
    const backoff = await getBackoff(db, SOURCE);
    if (backoff && clock.now() < backoff.nextAllowedAt) {
      return {
        ok: false,
        status: null,
        message: `backoff until ${new Date(backoff.nextAllowedAt).toISOString()}`,
        skipped: true,
      };
    }
    if (lastStartAt !== null) {
      const wait = lastStartAt + minSpacingMs - clock.now();
      if (wait > 0) await clock.sleep(wait);
    }
    const requestedAt = clock.now();
    lastStartAt = requestedAt;

    let res: Response;
    try {
      res = await sourceFetch(db, SOURCE, url, {
        now: requestedAt,
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs ?? 30_000,
        headers: { "User-Agent": config.userAgent, Accept: "application/json" },
      });
    } catch (err) {
      return fail(null, SERVER_ERROR_BACKOFF, `network error: ${String(err)}`);
    }

    if (res.status >= 400 && res.status < 500) {
      await discardBody(res);
      return fail(res.status, CLIENT_ERROR_BACKOFF, `HTTP ${res.status}, flights stopped`);
    }
    if (!res.ok) {
      await discardBody(res);
      return fail(res.status, SERVER_ERROR_BACKOFF, `HTTP ${res.status}`);
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch (err) {
      payload = null;
      await logFetchError(
        db,
        SOURCE,
        url,
        res.status,
        `unreadable body: ${String(err)}`,
        clock.now(),
      );
    }
    if (!isRecord(payload) || !Array.isArray(payload.ac)) {
      if (payload !== null) {
        await logFetchError(db, SOURCE, url, res.status, "payload has no ac array", clock.now());
      }
      return fail(res.status, SERVER_ERROR_BACKOFF, "unexpected payload");
    }
    await recordSuccess(db, SOURCE);
    return {
      ok: true,
      now: responseNowMs(payload.now, clock.now()),
      aircraft: payload.ac,
      requestedAt,
    };
  }

  return {
    name: "adsb.lol",
    // The caller's `now` is its schedule time; the queue's own clock decides when a request starts.
    fetchArea(area) {
      const run = tail.then(() => request(area));
      tail = run.catch(() => undefined);
      return run;
    },
  };
}
