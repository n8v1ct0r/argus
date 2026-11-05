// Flight redaction, before anything is stored (docs/plan.md section 2). The output is built
// field by field from an allow-list, so nothing else in the upstream record can reach the
// database: no registration, callsign, owner, type, description, squawk, or ICAO address.
// The emitter category (A0 to D7) is kept: it describes a class of aircraft, not one aircraft.
// LADD and PIA aircraft are removed entirely.
import type { FlightSample } from "../../../detectors/types.ts";

/** readsb dbFlags bits: 4 = PIA (privacy ICAO address), 8 = LADD (FAA display opt-out). */
const DB_FLAG_PIA = 4;
const DB_FLAG_LADD = 8;
const MS_PER_S = 1000;

/** Bumped whenever the allow-list changes; stored in frame meta. */
export const REDACTION_VERSION = "v2";

/** ADS-B emitter categories: a letter A to D and a digit 0 to 7. */
const CATEGORY_PATTERN = /^[A-D][0-7]$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** True when the aircraft must never be stored in any form. */
export function isOptedOut(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const flags = typeof raw.dbFlags === "number" ? raw.dbFlags : 0;
  return (flags & DB_FLAG_LADD) !== 0 || (flags & DB_FLAG_PIA) !== 0;
}

/**
 * Turns one upstream aircraft record into a FlightSample, or null when it must be dropped
 * (LADD, PIA, no position, no position age, or no address to derive an id from).
 */
export function redactAircraft(
  raw: unknown,
  responseNowMs: number,
  idFor: (hex: string, t: number) => string,
): FlightSample | null {
  if (!isRecord(raw) || isOptedOut(raw)) return null;
  const hex = typeof raw.hex === "string" ? raw.hex.trim() : "";
  const lat = finiteOrNull(raw.lat);
  const lon = finiteOrNull(raw.lon);
  const seenPos = finiteOrNull(raw.seen_pos);
  if (!hex || lat === null || lon === null || seenPos === null || seenPos < 0) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const t = Math.round(responseNowMs - seenPos * MS_PER_S);
  const onGround = raw.alt_baro === "ground";
  return {
    aircraft: idFor(hex, t),
    t,
    lat,
    lon,
    altFt: finiteOrNull(raw.alt_baro),
    groundSpeedKt: finiteOrNull(raw.gs),
    trackDeg: finiteOrNull(raw.track),
    onGround,
    positionAgeS: seenPos,
    category:
      typeof raw.category === "string" && CATEGORY_PATTERN.test(raw.category) ? raw.category : null,
  };
}

/** Redacts a whole response, keeping upstream order and dropping what redactAircraft drops. */
export function redactAll(
  aircraft: unknown[],
  responseNowMs: number,
  idFor: (hex: string, t: number) => string,
): FlightSample[] {
  const out: FlightSample[] = [];
  for (const raw of aircraft) {
    const sample = redactAircraft(raw, responseNowMs, idFor);
    if (sample) out.push(sample);
  }
  return out;
}
