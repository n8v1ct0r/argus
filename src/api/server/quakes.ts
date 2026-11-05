// GET /api/layers/quakes?from&to: the newest live version of every earthquake with an origin
// time in the window and a USGS type the cluster detector counts (quarry blasts and explosions
// stay off the globe). mag is facts.mag.text exactly as USGS wrote it.
import { config } from "../../../argus.config.ts";
import type { Db } from "../../db/client.ts";
import type { LayerPayload, QuakeItem } from "../types.ts";
import { linkedMembers, liveDetections, newestLiveVersions } from "./store.ts";
import type { Window } from "./params.ts";

export type QuakesLayer = Extract<LayerPayload, { layer: "quakes" }>;

const QUAKE_TYPES: readonly string[] = config.detectors.quakeCluster.quakeTypes;
export const QUAKE_CLUSTER_DETECTOR = "quake-cluster";

/** Quakes in [from, to], oldest first; inFinding when a live cluster in the window cites one. */
export async function quakeItems(db: Db, w: Window): Promise<QuakeItem[]> {
  const quakes = (await newestLiveVersions(db, { kind: "earthquake", from: w.from, to: w.to }))
    .filter((e) => e.occurredAt >= w.from && e.occurredAt <= w.to)
    .filter((e) => QUAKE_TYPES.includes(e.facts.type?.text ?? ""));
  const clusters = await liveDetections(db, QUAKE_CLUSTER_DETECTOR, w.from, w.to);
  const cited = await linkedMembers(
    db,
    clusters.map((c) => c.id),
  );

  const items: QuakeItem[] = [];
  for (const e of quakes) {
    const mag = e.facts.mag;
    if (!mag || e.lat === null || e.lon === null) continue;
    const magValue = typeof mag.value === "number" ? mag.value : Number(mag.text);
    if (!Number.isFinite(magValue)) continue;
    items.push({
      id: e.id,
      lon: e.lon,
      lat: e.lat,
      mag: mag.text,
      magValue,
      occurredAt: e.occurredAt,
      inFinding: cited.ids.has(e.id) || cited.recordKeys.has(e.recordKey),
    });
  }
  return items.sort((a, b) => a.occurredAt - b.occurredAt || (a.id < b.id ? -1 : 1));
}

export async function buildQuakesLayer(db: Db, w: Window): Promise<QuakesLayer> {
  return { layer: "quakes", from: w.from, to: w.to, items: await quakeItems(db, w) };
}
