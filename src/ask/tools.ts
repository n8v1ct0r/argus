// Ask Argus tools (docs/plan.md section 3e). They only read the store, except count_events, which
// saves its result as a content-addressed aggregate event so the count is citable.
//
// Privacy: search_events and count_events never touch flight_frame or aircraft_track, no tool
// result carries a stored version id (a circling detection's id contains the aircraft digest), and
// no tool takes a callsign, ICAO address, or registration. The model sees references ("E1", ...)
// from a RefTable, and the loop maps them back to version ids after the answer.
import { config } from "../../argus.config.ts";
import type { Db } from "../db/client.ts";
import { getEvents, getLinks, insertEvents, WriteBudgetExceeded } from "../db/queries.ts";
import { count, label, upstream, utcDate, utcTime } from "../events/facts.ts";
import type { BBox, EventRecord, Facts, Kind } from "../events/types.ts";
import { canonicalJson, sha256Hex } from "../lib/digest.ts";
import type { ModelTool } from "../model/client.ts";
import {
  BRIEF_WINDOW_MS,
  currentVersions,
  DETECTOR_LABELS,
  detectorOf,
  factTexts,
  isAircraftKind,
  isFlightId,
  scanEvents,
  type DetectorName,
} from "../brief/facts.ts";

/** Kinds a visitor can search and count. Flight kinds are never on this list. */
export const ASK_KINDS = [
  "earthquake",
  "natural_event",
  "detection",
  "fire_cell_day",
  "fire_batch",
  "satellite_elements",
] as const satisfies readonly Kind[];
export type AskKind = (typeof ASK_KINDS)[number];

export const DETECTOR_NAMES = [
  "quake_cluster",
  "fire_growth",
  "circling",
] as const satisfies readonly DetectorName[];

const SORTS = ["newest", "oldest", "largest_magnitude"] as const;
type Sort = (typeof SORTS)[number];

/** Rows a tool may scan before it asks for a narrower query. */
const SCAN_LIMIT = 100_000;
const MAX_LAT = 90;
const MAX_LON = 180;

/** Pack references for version ids, stable for one question: "E1" upward. */
export class RefTable {
  readonly #refOf = new Map<string, string>();
  readonly #idOf = new Map<string, string>();

  ref(id: string): string {
    let ref = this.#refOf.get(id);
    if (!ref) {
      ref = `E${this.#refOf.size + 1}`;
      this.#refOf.set(id, ref);
      this.#idOf.set(ref, id);
    }
    return ref;
  }

  resolve(ref: string): string | undefined {
    return this.#idOf.get(ref);
  }

  /** Version id to reference, for writing checker findings back in the model's terms. */
  get refOf(): ReadonlyMap<string, string> {
    return this.#refOf;
  }
}

export interface ToolContext {
  db: Db;
  refs: RefTable;
  now: number;
}

export interface ToolOutput {
  content: string;
  isError: boolean;
}

/** A tool input the tool cannot run; the message goes back to the model as the tool result. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

// ---------------------------------------------------------------------------------------------
// Schemas (strict: every object sets additionalProperties false)

const BBOX_SCHEMA = {
  type: "object",
  description:
    "Area in WGS84 degrees. When min_lon is greater than max_lon the box crosses the antimeridian.",
  properties: {
    min_lat: { type: "number" },
    min_lon: { type: "number" },
    max_lat: { type: "number" },
    max_lon: { type: "number" },
  },
  required: ["min_lat", "min_lon", "max_lat", "max_lon"],
  additionalProperties: false,
};
const KINDS_SCHEMA = {
  type: "array",
  description: "Event kinds to include (at least one).",
  items: { type: "string", enum: [...ASK_KINDS] },
};
const FROM_SCHEMA = {
  type: "string",
  format: "date-time",
  description: "Start of the time range, ISO 8601 in UTC. Default: 24 hours before `to`.",
};
const TO_SCHEMA = {
  type: "string",
  format: "date-time",
  description: "End of the time range, ISO 8601 in UTC. Default: now.",
};
const MIN_MAG_SCHEMA = {
  type: "number",
  description: "Leave out earthquakes below this magnitude. Other kinds are not affected.",
};

export const ASK_TOOLS: ModelTool[] = [
  {
    name: "search_events",
    description: `Find stored events by kind, area, and time: earthquakes, natural events (storms, volcanoes, floods, sea ice), detections, heat detection cells, fire detection batches, and satellite element sets. Call it to find the events a question is about. Returns up to "limit" events (at most ${config.ask.searchLimit}) with their references and facts. Never returns aircraft positions.`,
    input_schema: {
      type: "object",
      properties: {
        kinds: KINDS_SCHEMA,
        bbox: BBOX_SCHEMA,
        from: FROM_SCHEMA,
        to: TO_SCHEMA,
        min_magnitude: MIN_MAG_SCHEMA,
        sort: { type: "string", enum: [...SORTS], description: "Order of the results." },
        limit: {
          type: "integer",
          description: `How many events to return, 1 to ${config.ask.searchLimit}.`,
        },
      },
      required: ["kinds", "sort", "limit"],
      additionalProperties: false,
    },
  },
  {
    name: "get_events",
    description: `Read events by reference (like E3) from earlier tool results, with all their facts and, for detections, the references of their member events. At most ${config.ask.getEventsLimit} references per call.`,
    input_schema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "References from earlier tool results.",
        },
      },
      required: ["ids"],
      additionalProperties: false,
    },
  },
  {
    name: "list_detections",
    description:
      "List what Argus detected: earthquake clusters, heat detection growth, and circling aircraft, newest first. Call it for questions about clusters, fire growth, or circling. Circling detections never identify the aircraft.",
    input_schema: {
      type: "object",
      properties: {
        detector: {
          type: "string",
          enum: [...DETECTOR_NAMES],
          description: "Only this detector. Default: all.",
        },
        from: FROM_SCHEMA,
        to: TO_SCHEMA,
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "count_events",
    description:
      "Count stored events that match, and save the count as an aggregate event. Call it whenever an answer needs how many events match; cite the reference it returns, whose count fact holds the number. Never count results yourself.",
    input_schema: {
      type: "object",
      properties: {
        kinds: KINDS_SCHEMA,
        bbox: BBOX_SCHEMA,
        from: FROM_SCHEMA,
        to: TO_SCHEMA,
        min_magnitude: MIN_MAG_SCHEMA,
      },
      required: ["kinds"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Input validation (strict schemas already constrain the model; this guards everything else)

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface EventFilter {
  kinds: AskKind[];
  bbox: BBox | null;
  from: number;
  to: number;
  minMagnitude: number | null;
}

function parseTime(v: unknown, name: string): number | null {
  if (v === undefined || v === null) return null;
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms)) {
    throw new ToolInputError(`${name} must be an ISO 8601 time such as 2026-09-23T00:00:00Z.`);
  }
  return ms;
}

function parseRange(input: Json, now: number): { from: number; to: number } {
  const to = parseTime(input.to, "to") ?? now;
  const from = parseTime(input.from, "from") ?? to - BRIEF_WINDOW_MS;
  if (from > to) throw new ToolInputError("from must be before to.");
  return { from, to };
}

function parseKinds(v: unknown): AskKind[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new ToolInputError(`kinds must list at least one of: ${ASK_KINDS.join(", ")}.`);
  }
  const kinds = new Set<AskKind>();
  for (const k of v) {
    if (k === "flight_frame" || k === "aircraft_track") {
      throw new ToolInputError(
        "Aircraft positions are not searchable. Circling aircraft appear only as detections.",
      );
    }
    const known = ASK_KINDS.find((a) => a === k);
    if (!known)
      throw new ToolInputError(`Unknown kind ${String(k)}. Use: ${ASK_KINDS.join(", ")}.`);
    kinds.add(known);
  }
  return [...kinds].sort();
}

function parseBbox(v: unknown): BBox | null {
  if (v === undefined || v === null) return null;
  const b = isObj(v) ? v : {};
  const [minLat, minLon, maxLat, maxLon] = [b.min_lat, b.min_lon, b.max_lat, b.max_lon];
  const ok =
    typeof minLat === "number" &&
    typeof minLon === "number" &&
    typeof maxLat === "number" &&
    typeof maxLon === "number" &&
    [minLat, maxLat].every((x) => Math.abs(x) <= MAX_LAT) &&
    [minLon, maxLon].every((x) => Math.abs(x) <= MAX_LON) &&
    minLat <= maxLat;
  if (!ok) {
    throw new ToolInputError(
      "bbox needs min_lat <= max_lat within -90 to 90 and longitudes within -180 to 180.",
    );
  }
  return { minLat, minLon, maxLat, maxLon };
}

function parseFilter(input: Json, now: number): EventFilter {
  const min = input.min_magnitude;
  if (min !== undefined && min !== null && !(typeof min === "number" && Number.isFinite(min))) {
    throw new ToolInputError("min_magnitude must be a number.");
  }
  return {
    kinds: parseKinds(input.kinds),
    bbox: parseBbox(input.bbox),
    ...parseRange(input, now),
    minMagnitude: typeof min === "number" ? min : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Matching

function inBox(e: EventRecord, b: BBox | null): boolean {
  if (!b) return true;
  if (e.lat === null || e.lon === null) return false;
  if (e.lat < b.minLat || e.lat > b.maxLat) return false;
  return b.minLon <= b.maxLon
    ? e.lon >= b.minLon && e.lon <= b.maxLon
    : e.lon >= b.minLon || e.lon <= b.maxLon;
}

function magnitudeOf(e: EventRecord): number | null {
  const v = e.facts.mag?.value;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function passesMagnitude(e: EventRecord, min: number | null): boolean {
  if (min === null || e.kind !== "earthquake") return true;
  const mag = magnitudeOf(e);
  return mag !== null && mag >= min;
}

/**
 * Live versions (newest as of now, not ended) of the events that match. `foundInRange` also
 * admits detections found in the range but dated before it (fire growth is dated a day back).
 */
async function matching(
  ctx: ToolContext,
  f: EventFilter,
  foundInRange = false,
): Promise<EventRecord[]> {
  const scanFrom = foundInRange ? f.from - BRIEF_WINDOW_MS : f.from;
  const rows = await scanEvents(ctx.db, f.kinds, scanFrom, f.to, SCAN_LIMIT);
  if (rows.length >= SCAN_LIMIT) {
    throw new ToolInputError(
      "Too many events match. Narrow the time range, the area, or the kinds.",
    );
  }
  const current = await currentVersions(
    ctx.db,
    rows.map((e) => e.recordKey),
    ctx.now,
  );
  const kinds: readonly Kind[] = f.kinds;
  return [...current.values()].filter((e) => {
    const t = foundInRange ? Math.max(e.occurredAt, e.fetchedAt) : e.occurredAt;
    return (
      kinds.includes(e.kind) &&
      !isAircraftKind(e.kind) &&
      t >= f.from &&
      e.occurredAt <= f.to &&
      inBox(e, f.bbox) &&
      passesMagnitude(e, f.minMagnitude)
    );
  });
}

function byId(a: EventRecord, b: EventRecord): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sortEvents(events: EventRecord[], sort: Sort): EventRecord[] {
  const newest = (a: EventRecord, b: EventRecord) => b.occurredAt - a.occurredAt || byId(a, b);
  if (sort === "oldest") return events.sort((a, b) => a.occurredAt - b.occurredAt || byId(a, b));
  if (sort === "largest_magnitude") {
    const mag = (e: EventRecord) => magnitudeOf(e) ?? Number.NEGATIVE_INFINITY;
    return events.sort((a, b) => mag(b) - mag(a) || newest(a, b));
  }
  return events.sort(newest);
}

interface EventView {
  id: string;
  kind: Kind;
  detector?: string;
  title: string;
  facts: Record<string, string>;
  members?: string[];
}

/** What the model sees of an event: a reference, never a version id, and never meta or raw. */
function view(ctx: ToolContext, e: EventRecord, members?: string[]): EventView {
  const detector = detectorOf(e);
  return {
    id: ctx.refs.ref(e.id),
    kind: e.kind,
    ...(detector ? { detector: DETECTOR_LABELS[detector] } : {}),
    title: e.title,
    facts: factTexts(e),
    ...(members ? { members } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Tools

async function searchEvents(ctx: ToolContext, input: Json) {
  const f = parseFilter(input, ctx.now);
  const sort = SORTS.find((s) => s === input.sort) ?? "newest";
  const rawLimit =
    typeof input.limit === "number" ? Math.floor(input.limit) : config.ask.searchLimit;
  const limit = Math.min(config.ask.searchLimit, Math.max(1, rawLimit));
  const events = sortEvents(await matching(ctx, f), sort);
  return {
    events: events.slice(0, limit).map((e) => view(ctx, e)),
    more_available: events.length > limit,
  };
}

async function getEventsTool(ctx: ToolContext, input: Json) {
  const refs = input.ids;
  if (!Array.isArray(refs) || !refs.every((r): r is string => typeof r === "string")) {
    throw new ToolInputError("ids must be a list of references such as E3.");
  }
  if (refs.length > config.ask.getEventsLimit) {
    throw new ToolInputError(`Ask for at most ${config.ask.getEventsLimit} references at a time.`);
  }
  const wanted = [...new Set(refs)];
  const ids = wanted.flatMap((r) => {
    const id = ctx.refs.resolve(r);
    return id ? [id] : [];
  });
  const found = (await getEvents(ctx.db, ids)).filter((e) => !isAircraftKind(e.kind));
  const events: EventView[] = [];
  for (const e of found) {
    const members =
      e.kind === "detection"
        ? (await getLinks(ctx.db, e.id))
            .filter((id) => !isFlightId(id))
            .sort()
            .slice(0, config.ask.getEventsLimit)
            .map((id) => ctx.refs.ref(id))
        : undefined;
    events.push(view(ctx, e, members));
  }
  const shown = new Set(events.map((e) => e.id));
  return { events, missing: wanted.filter((r) => !shown.has(r)) };
}

async function listDetections(ctx: ToolContext, input: Json) {
  const detector = DETECTOR_NAMES.find((d) => d === input.detector) ?? null;
  if (input.detector !== undefined && input.detector !== null && !detector) {
    throw new ToolInputError(`detector must be one of: ${DETECTOR_NAMES.join(", ")}.`);
  }
  const f: EventFilter = {
    kinds: ["detection"],
    bbox: null,
    ...parseRange(input, ctx.now),
    minMagnitude: null,
  };
  const events = sortEvents(await matching(ctx, f, true), "newest").filter(
    (e) => detectorOf(e) !== null && (detector === null || detectorOf(e) === detector),
  );
  return {
    events: events.slice(0, config.ask.searchLimit).map((e) => view(ctx, e)),
    more_available: events.length > config.ask.searchLimit,
  };
}

/** The aggregate event for a count: its id is a digest of the normalized query and member set. */
export function buildAggregate(f: EventFilter, memberIds: string[], now: number): EventRecord {
  const members = [...memberIds].sort();
  const query = {
    kinds: f.kinds,
    bbox: f.bbox,
    from: f.from,
    to: f.to,
    min_magnitude: f.minMagnitude,
  };
  const digest = sha256Hex(canonicalJson({ query, members }));
  const nativeId = `aggregate:${digest.slice(0, 16)}`;
  const listed = members.slice(0, config.ask.maxAggregateMembers);
  const facts: Facts = {
    count: count(members.length),
    kinds: label(f.kinds.join(", ")),
    from_date: utcDate(f.from),
    from_time: utcTime(f.from),
    to_date: utcDate(f.to),
    to_time: utcTime(f.to),
  };
  if (f.minMagnitude !== null) facts.min_magnitude = upstream(f.minMagnitude);
  if (f.bbox) {
    facts.min_lat = upstream(f.bbox.minLat, "deg");
    facts.min_lon = upstream(f.bbox.minLon, "deg");
    facts.max_lat = upstream(f.bbox.maxLat, "deg");
    facts.max_lon = upstream(f.bbox.maxLon, "deg");
  }
  facts.members = { value: listed.join(","), text: listed.join(", ") };
  const raw = canonicalJson({
    query,
    count: members.length,
    members: listed,
    members_truncated: members.length > listed.length,
  });
  const center = f.bbox
    ? { lat: (f.bbox.minLat + f.bbox.maxLat) / 2, lon: (f.bbox.minLon + f.bbox.maxLon) / 2 }
    : { lat: null, lon: null };
  return {
    id: `argus:${nativeId}`,
    recordKey: `argus:${nativeId}`,
    source: "argus",
    kind: "aggregate",
    occurredAt: f.to,
    fetchedAt: now,
    sourceUpdatedAt: null,
    ...center,
    bbox: f.bbox,
    title: `Count of ${f.kinds.join(", ")} events`,
    facts,
    meta: { writer: "ask", query, membersTruncated: members.length > listed.length },
    raw,
    rawGz: null,
    rawDigest: sha256Hex(raw),
    fetchId: null,
    supersedes: null,
  };
}

async function countEvents(ctx: ToolContext, input: Json) {
  const f = parseFilter(input, ctx.now);
  const events = await matching(ctx, f);
  const aggregate = buildAggregate(
    f,
    events.map((e) => e.id),
    ctx.now,
  );
  // Re-asking the same count finds the stored row and writes nothing.
  await insertEvents(ctx.db, [aggregate], "ask", ctx.now);
  return { aggregate: view(ctx, aggregate) };
}

/** Runs one tool call. Bad input comes back as an error result the model can read. */
export async function runTool(ctx: ToolContext, name: string, input: unknown): Promise<ToolOutput> {
  const args = isObj(input) ? input : {};
  try {
    let out: unknown;
    if (name === "search_events") out = await searchEvents(ctx, args);
    else if (name === "get_events") out = await getEventsTool(ctx, args);
    else if (name === "list_detections") out = await listDetections(ctx, args);
    else if (name === "count_events") out = await countEvents(ctx, args);
    else return { content: `Unknown tool ${name}.`, isError: true };
    return { content: JSON.stringify(out), isError: false };
  } catch (err) {
    if (err instanceof ToolInputError) return { content: err.message, isError: true };
    if (err instanceof WriteBudgetExceeded) {
      return {
        content: "Argus cannot save new counts today. Answer without a count.",
        isError: true,
      };
    }
    throw err;
  }
}
