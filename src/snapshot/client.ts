"use client";
// Answers the app's API URLs from the recorded snapshot files, in snapshot mode only. Each
// file is fetched once per page load.
import type { AskResponse, CitationEvent, EventsPayload } from "../api/types.ts";
import type { SnapshotManifest } from "./types.ts";

const BASE = "/snapshot";
const files = new Map<string, Promise<unknown>>();

function load<T>(name: string): Promise<T> {
  let p = files.get(name);
  if (!p) {
    p = fetch(`${BASE}/${name}`).then((res) => {
      if (!res.ok) throw new Error(`The recorded file ${name} answered ${res.status}.`);
      return res.json();
    });
    p.catch(() => files.delete(name));
    files.set(name, p);
  }
  return p as Promise<T>;
}

export function snapshotManifest(): Promise<SnapshotManifest> {
  return load<SnapshotManifest>("manifest.json");
}

export interface PresetAnswer {
  question: string;
  response: AskResponse;
}

export function snapshotAsk(): Promise<PresetAnswer[]> {
  return load<PresetAnswer[]>("ask.json");
}

/** The newest recorded payload at or before `at`, or an empty layer. */
async function atFile(kind: "flights" | "fires", at: number): Promise<unknown> {
  const m = await snapshotManifest();
  const index = m[kind];
  let best: number | null = null;
  for (const key of Object.keys(index)) {
    const t = Number(key);
    if (t <= at && (best === null || t > best)) best = t;
  }
  if (best === null) {
    return kind === "flights"
      ? { layer: "flights", from: at, to: at, frameTimes: [], items: [] }
      : { layer: "fires", from: at, to: at, items: [] };
  }
  return load(index[String(best)]!);
}

/** The JSON body the API route would answer for `url`, read from the snapshot. */
export async function snapshotGet(url: string): Promise<unknown> {
  const u = new URL(url, "http://snapshot.local");
  const sp = u.searchParams;
  switch (u.pathname) {
    case "/api/status": {
      return load("status.json");
    }
    case "/api/brief":
      return load("brief.json");
    case "/api/replay":
      return load("replay.json");
    case "/api/layers/quakes":
      return load("quakes.json");
    case "/api/layers/events":
      return load("events-layer.json");
    case "/api/layers/satellites":
      return load("satellites.json");
    case "/api/layers/flights":
      return atFile("flights", Number(sp.get("at")));
    case "/api/layers/fires":
      return atFile("fires", Number(sp.get("at")));
    case "/api/events": {
      const all = await load<Record<string, CitationEvent>>("events.json");
      const ids = (sp.get("ids") ?? "").split(",").filter(Boolean);
      const payload: EventsPayload = { events: [], missing: [] };
      for (const id of ids) {
        const e = all[id];
        if (e) payload.events.push(e);
        else payload.missing.push(id);
      }
      return payload;
    }
    default:
      throw new Error(`The recorded snapshot has no data for ${u.pathname}.`);
  }
}
