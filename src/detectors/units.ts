// Named unit constants for detector code. Detector modules may contain no numeric literal other
// than 0, 1, or 360 (tests/unit/detectors-no-literals.spec.ts): every threshold lives in
// argus.config.ts and every conversion factor or format width lives here.
export { MS_PER_DAY, MS_PER_HOUR } from "../lib/time.ts";

export const MS_PER_SECOND = 1000;
export const SECONDS_PER_MINUTE = 60;
export const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;
export const HOURS_PER_DAY = 24;

export const FULL_TURN_DEG = 360;
/** Degrees of longitude the mean sun crosses per hour (15). */
export const DEG_LON_PER_HOUR = FULL_TURN_DEG / HOURS_PER_DAY;
/**
 * Local solar day bins start at 06:00 local solar time, matching localSolarDayKey in
 * src/lib/time.ts, so a satellite's day pass and the following night pass share one bin.
 */
export const SOLAR_DAY_START_H = 6;

export const HALF = 0.5;
export const PERCENT = 100;

/** Hex characters of a SHA-256 digest kept in content-addressed detection ids. */
export const DIGEST_ID_HEX_CHARS = 12;
/** Decimals shown for computed distances in km. */
export const DISTANCE_DECIMALS = 1;
/** Decimals shown for computed spans in hours. */
export const HOURS_DECIMALS = 1;
