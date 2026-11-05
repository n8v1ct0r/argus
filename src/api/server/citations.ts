// GET /api/events?ids=a,b: stored event versions for the citation panel. Versions are returned
// as stored, including versions of records that have since ended, because a citation must keep
// resolving to the exact version it cited.
//
// Privacy: flight records (frames and aircraft tracks) are stored with a salted aircraft digest
// per sample. The panel shows them with that field removed, and says so.
import type { Db } from "../../db/client.ts";
import { getEvents } from "../../db/queries.ts";
import type { EventRecord } from "../../events/types.ts";
import { gunzipText } from "../../lib/gzip.ts";
import type { CitationEvent, EventsPayload } from "../types.ts";
import { creditFor, linksOf } from "./store.ts";

/** The stored record is shown up to this many characters. */
export const RECORD_MAX_CHARS = 8000;
const AIRCRAFT_FIELD = "aircraft";

export const AIRCRAFT_REMOVED_NOTE =
  "Aircraft ids are removed from this view. The digest covers the record as stored.";
export const AIRCRAFT_UNREADABLE_NOTE =
  "This flight record could not be read without its aircraft ids, so it is not shown.";

/** Drops the aircraft digest from every sample of a stored flight record, or null if unreadable. */
export function withoutAircraft(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (typeof v === "object" && v !== null) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k]) => k !== AIRCRAFT_FIELD)
          .map(([k, x]) => [k, strip(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(strip(parsed));
}

/** Trims to RECORD_MAX_CHARS without splitting a surrogate pair. */
export function trimRecord(text: string): { text: string; leftOut: number } {
  if (text.length <= RECORD_MAX_CHARS) return { text, leftOut: 0 };
  let kept = text.slice(0, RECORD_MAX_CHARS);
  const last = kept.charCodeAt(kept.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) kept = kept.slice(0, -1);
  return { text: kept, leftOut: text.length - kept.length };
}

function storedText(e: EventRecord): string {
  if (e.raw !== null) return e.raw;
  return e.rawGz ? gunzipText(e.rawGz) : "";
}

/** The record text and note the panel shows for one event. */
export function recordView(e: EventRecord): { record: string; recordNote: string | null } {
  const notes: string[] = [];
  let text = storedText(e);
  if (e.source === "flights") {
    const stripped = withoutAircraft(text);
    if (stripped === null) return { record: "", recordNote: AIRCRAFT_UNREADABLE_NOTE };
    text = stripped;
    notes.push(AIRCRAFT_REMOVED_NOTE);
  }
  const { text: shown, leftOut } = trimRecord(text);
  if (leftOut > 0) {
    notes.push(
      `The stored record is ${text.length} characters long. The first ${shown.length} are shown and ${leftOut} are left out.`,
    );
  }
  return { record: shown, recordNote: notes.length ? notes.join(" ") : null };
}

function toCitation(e: EventRecord, members: string[]): CitationEvent {
  return {
    id: e.id,
    source: e.source,
    kind: e.kind,
    title: e.title,
    occurredAt: e.occurredAt,
    fetchedAt: e.fetchedAt,
    lat: e.lat,
    lon: e.lon,
    bbox: e.bbox ? [e.bbox.minLon, e.bbox.minLat, e.bbox.maxLon, e.bbox.maxLat] : null,
    facts: e.facts,
    ...recordView(e),
    rawDigest: e.rawDigest,
    supersedes: e.supersedes,
    members,
    credit: creditFor(e.source),
  };
}

/** An aggregate lists its members in facts (docs/plan.md 3e); every other kind uses event_links. */
function membersOf(e: EventRecord, links: Map<string, string[]>): string[] {
  if (e.kind === "aggregate") {
    const listed = e.facts.members?.value;
    return typeof listed === "string" && listed ? listed.split(",") : [];
  }
  return links.get(e.id) ?? [];
}

/** Events in request order; ids with no stored version go to missing. */
export async function buildEventsPayload(db: Db, p: { ids: string[] }): Promise<EventsPayload> {
  const found = await getEvents(db, p.ids);
  const links = await linksOf(
    db,
    found.map((e) => e.id),
  );
  const byId = new Map(found.map((e) => [e.id, e]));
  const events: CitationEvent[] = [];
  const missing: string[] = [];
  for (const id of p.ids) {
    const e = byId.get(id);
    if (e) events.push(toCitation(e, membersOf(e, links)));
    else missing.push(id);
  }
  return { events, missing };
}
