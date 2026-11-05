// GET /api/layers/events?from&to[&wildfires=1]: EONET natural events with a geometry inside the
// window. Each event is drawn at its latest geometry in the window. Wildfires stay out unless
// asked for, because FIRMS covers fires.
import type { Db } from "../../db/client.ts";
import type { EventRecord } from "../../events/types.ts";
import {
  sanitizeEonetEvent,
  type EonetGeometry,
  type LonLat,
  type SanitizedEvent,
} from "../../ingest/sources/eonet.ts";
import type { LayerPayload, NaturalEventItem } from "../types.ts";
import type { Window } from "./params.ts";
import { newestLiveVersions } from "./store.ts";

export type EventsLayer = Extract<LayerPayload, { layer: "events" }>;

const WILDFIRES_ID = "wildfires";
const WILDFIRES_TITLE = "Wildfires";
const FALLBACK_CATEGORY = "Natural event";

export interface NaturalEventView {
  record: EventRecord;
  event: SanitizedEvent;
  category: string;
  wildfire: boolean;
}

/**
 * The newest live version of every EONET event whose newest geometry is at or after `from`
 * (the only events that can have a geometry in a window starting there), parsed from raw with
 * the same sanitation the adapter applied at fetch time.
 */
export async function naturalEventViews(db: Db, from: number): Promise<NaturalEventView[]> {
  const records = await newestLiveVersions(db, { kind: "natural_event", from, withRaw: true });
  const out: NaturalEventView[] = [];
  for (const record of records) {
    if (record.raw === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.raw);
    } catch {
      continue;
    }
    const event = sanitizeEonetEvent(parsed, record.fetchedAt);
    if (!event) continue;
    const wildfire = event.categories.some(
      (c) => c.id.toLowerCase() === WILDFIRES_ID || c.title === WILDFIRES_TITLE,
    );
    const category = record.facts.category?.text ?? event.categories[0]?.title;
    out.push({ record, event, category: category ?? FALLBACK_CATEGORY, wildfire });
  }
  return out.sort((a, b) => (a.record.id < b.record.id ? -1 : 1));
}

/** Geometries of one event with a time in [from, to], oldest first. */
export function geometriesIn(view: NaturalEventView, w: Window): EonetGeometry[] {
  return view.event.geometry.filter((g) => g.time >= w.from && g.time <= w.to);
}

function ringBox(ring: LonLat[]): [number, number, number, number] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of ring) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return [west, south, east, north];
}

function vertexMean(ring: LonLat[]): { lon: number; lat: number } {
  const first = ring[0];
  const last = ring[ring.length - 1];
  const closed = ring.length > 1 && first && last && first[0] === last[0] && first[1] === last[1];
  const pts = closed ? ring.slice(0, -1) : ring;
  let lon = 0;
  let lat = 0;
  for (const [x, y] of pts) {
    lon += x;
    lat += y;
  }
  return { lon: lon / pts.length, lat: lat / pts.length };
}

/**
 * Where to draw a geometry. The newest geometry uses the stored record's point (the adapter's
 * area centroid); an older polygon uses the mean of its outer ring's vertices.
 */
function placeOf(
  g: EonetGeometry,
  record: EventRecord,
): { lon: number; lat: number; bbox: NaturalEventItem["bbox"] } | null {
  if (g.type === "Point") return { lon: g.coordinates[0], lat: g.coordinates[1], bbox: null };
  const outer = g.coordinates[0];
  if (!outer?.length) return null;
  const bbox = ringBox(outer);
  const point =
    g.time === record.occurredAt && record.lat !== null && record.lon !== null
      ? { lon: record.lon, lat: record.lat }
      : vertexMean(outer);
  return { ...point, bbox };
}

export async function buildEventsLayer(
  db: Db,
  p: Window & { wildfires: boolean },
): Promise<EventsLayer> {
  const items: NaturalEventItem[] = [];
  for (const view of await naturalEventViews(db, p.from)) {
    if (view.wildfire && !p.wildfires) continue;
    const latest = geometriesIn(view, p).at(-1);
    if (!latest) continue;
    const place = placeOf(latest, view.record);
    if (!place) continue;
    items.push({
      id: view.record.id,
      ...place,
      category: view.category,
      title: view.record.title,
      occurredAt: latest.time,
    });
  }
  items.sort((a, b) => a.occurredAt - b.occurredAt || (a.id < b.id ? -1 : 1));
  return { layer: "events", from: p.from, to: p.to, items };
}
