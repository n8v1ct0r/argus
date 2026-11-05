// Interpolates server SGP4 positions (a 5-minute grid) to any replay time. Spherical
// interpolation of the direction plus linear height keeps orbits round between grid points.

import type { SatelliteGrid } from "../api/types.ts";

const DEG = Math.PI / 180;

function toVec(lon: number, lat: number): [number, number, number] {
  const cl = Math.cos(lat * DEG);
  return [cl * Math.cos(lon * DEG), cl * Math.sin(lon * DEG), Math.sin(lat * DEG)];
}

function slerp(
  a: [number, number, number],
  b: [number, number, number],
  f: number,
): [number, number, number] {
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const omega = Math.acos(dot);
  if (omega < 1e-9) return a;
  const s = Math.sin(omega);
  const wa = Math.sin((1 - f) * omega) / s;
  const wb = Math.sin(f * omega) / s;
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb];
}

/** Returns [lon, lat, heightMeters] triples at time t for every id with a valid position. */
export function positionsAt(
  grid: SatelliteGrid,
  t: number,
): { ids: string[]; positions: Float64Array } {
  const { times } = grid;
  if (!times.length) return { ids: [], positions: new Float64Array() };
  let i = 0;
  while (i < times.length - 2 && (times[i + 1] ?? 0) <= t) i++;
  const t0 = times[i] ?? 0;
  const t1 = times[i + 1] ?? t0;
  const f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
  const row0 = grid.positions[i] ?? [];
  const row1 = grid.positions[i + 1] ?? row0;
  const ids: string[] = [];
  const out: number[] = [];
  grid.ids.forEach((id, k) => {
    const lon0 = row0[k * 3];
    const lat0 = row0[k * 3 + 1];
    const h0 = row0[k * 3 + 2];
    const lon1 = row1[k * 3] ?? lon0;
    const lat1 = row1[k * 3 + 1] ?? lat0;
    const h1 = row1[k * 3 + 2] ?? h0;
    if (lon0 === undefined || lat0 === undefined || h0 === undefined) return;
    if ([lon0, lat0, h0, lon1, lat1, h1].some((v) => v === undefined || Number.isNaN(v))) return;
    const v = slerp(toVec(lon0, lat0), toVec(lon1 as number, lat1 as number), f);
    const lon = Math.atan2(v[1], v[0]) / DEG;
    const lat = Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG;
    ids.push(id);
    out.push(lon, lat, h0 + ((h1 as number) - h0) * f);
  });
  return { ids, positions: new Float64Array(out) };
}
