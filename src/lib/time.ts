export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

/**
 * Local solar day key: floor((utc_hours_since_epoch + lon / 15 - 6) / 24). Puts a satellite's
 * night pass (about 01:00 local) and day pass (about 13:00 local) in the same bin.
 */
export function localSolarDayKey(ms: number, lon: number): number {
  const utcHours = ms / MS_PER_HOUR;
  return Math.floor((utcHours + lon / 15 - 6) / 24);
}

/**
 * The calendar date of a local solar day. Day key k runs from 06:00 to 06:00 local solar time
 * starting on local date k, so its label is date k at every longitude. (An earlier version
 * dated local 18:00 in UTC and named the next day west of 90 W; caught by the FIRMS module.)
 */
export function dayKeyLabel(dayKey: number): string {
  return new Date(dayKey * MS_PER_DAY).toISOString().slice(0, 10);
}

/** UTC instant a local solar day starts at a longitude (inverse of localSolarDayKey). */
export function solarDayStartMs(dayKey: number, lon: number): number {
  return (dayKey * 24 + 6 - lon / 15) * MS_PER_HOUR;
}

/**
 * UTC instant of local solar noon on a solar day at a longitude, close to the daytime satellite
 * pass (about 13:00 local). Its UTC date equals dayKeyLabel(dayKey) at every longitude.
 */
export function solarNoonMs(dayKey: number, lon: number): number {
  return Math.round(solarDayStartMs(dayKey, lon) + 6 * MS_PER_HOUR);
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
