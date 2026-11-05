// SGP4 on the server. satellite.js is a serverExternalPackage (see next.config.ts): the browser
// never loads it. Positions are model estimates from mean elements, not observations.
import {
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  json2satrec,
  propagate,
} from "satellite.js";
import type { OMMJsonObject, SatRec } from "satellite.js";
import type { SatelliteGrid } from "../api/types.ts";

const KM_TO_M = 1000;

export interface ElementSet {
  id: string;
  name: string;
  omm: Record<string, string>;
}

/** Propagates every element set at every time. Skips sets that fail to parse. */
export function propagateGrid(sets: ElementSet[], times: number[]): SatelliteGrid {
  const recs: Array<{ set: ElementSet; satrec: SatRec }> = [];
  for (const set of sets) {
    try {
      // json2satrec converts each OMM value with Number(), so CSV strings are accepted.
      recs.push({ set, satrec: json2satrec(set.omm as unknown as OMMJsonObject) });
    } catch {
      // A malformed element set is left out of the layer.
    }
  }
  const positions = times.map((t) => {
    const date = new Date(t);
    const gmst = gstime(date);
    const row: number[] = [];
    for (const r of recs) {
      const pv = propagate(r.satrec, date);
      const p = pv?.position;
      if (!p || typeof p === "boolean") {
        row.push(Number.NaN, Number.NaN, Number.NaN);
        continue;
      }
      const geo = eciToGeodetic(p, gmst);
      row.push(
        round(degreesLong(geo.longitude), 4),
        round(degreesLat(geo.latitude), 4),
        Math.round(geo.height * KM_TO_M),
      );
    }
    return row;
  });
  return { ids: recs.map((r) => r.set.id), names: recs.map((r) => r.set.name), times, positions };
}

function round(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}
