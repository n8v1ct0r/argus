"use client";
// The live layer of the static deploy: the USGS past-day GeoJSON feed, fetched in the browser at
// view time (USGS serves it with open CORS). Quakes already in the recording are left out, so a
// ring here is a quake the recording does not have.
import { useEffect, useState } from "react";
import { config } from "../../argus.config.ts";

export interface LiveQuake {
  /** The USGS event id, e.g. "us7000abcd". */
  id: string;
  lon: number;
  lat: number;
  mag: number | null;
  time: number;
  place: string;
}

export interface LiveQuakes {
  items: LiveQuake[] | null;
  /** When the browser received the feed. */
  fetchedAt: number | null;
  error: string | null;
}

interface Feature {
  id?: unknown;
  properties?: { mag?: unknown; time?: unknown; place?: unknown; type?: unknown };
  geometry?: { coordinates?: unknown };
}

/** Parses the feed, keeping earthquakes with a position and dropping recorded USGS ids. */
export function parseUsgsFeed(body: unknown, recordedUsgsIds: ReadonlySet<string>): LiveQuake[] {
  const features = (body as { features?: unknown })?.features;
  if (!Array.isArray(features)) return [];
  const out: LiveQuake[] = [];
  for (const f of features as Feature[]) {
    const id = typeof f.id === "string" ? f.id : null;
    const c = f.geometry?.coordinates;
    const p = f.properties ?? {};
    if (!id || recordedUsgsIds.has(id) || !Array.isArray(c)) continue;
    const [lon, lat] = c as unknown[];
    if (typeof lon !== "number" || typeof lat !== "number") continue;
    if (p.type !== undefined && p.type !== "earthquake") continue;
    out.push({
      id,
      lon,
      lat,
      mag: typeof p.mag === "number" ? p.mag : null,
      time: typeof p.time === "number" ? p.time : 0,
      place: typeof p.place === "string" ? p.place : "",
    });
  }
  return out;
}

/** The USGS id of a stored quake version id ("usgs:us7000abcd@1790..." gives "us7000abcd"). */
export function usgsIdOf(versionId: string): string | null {
  const m = /^usgs:([^@]+)@/.exec(versionId);
  return m ? m[1]! : null;
}

/** Fetches the feed once when `enabled` turns on and the recorded ids are known. */
export function useLiveQuakes(enabled: boolean, recordedIds: readonly string[] | null): LiveQuakes {
  const [state, setState] = useState<LiveQuakes>({ items: null, fetchedAt: null, error: null });
  useEffect(() => {
    if (!enabled || recordedIds === null) return;
    const ctrl = new AbortController();
    const recorded = new Set(recordedIds.map(usgsIdOf).filter((v): v is string => v !== null));
    fetch(config.sources.usgs.url, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`USGS answered ${res.status}.`);
        const body: unknown = await res.json();
        if (ctrl.signal.aborted) return;
        setState({ items: parseUsgsFeed(body, recorded), fetchedAt: Date.now(), error: null });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({
          items: null,
          fetchedAt: null,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => ctrl.abort();
  }, [enabled, recordedIds]);
  return state;
}
