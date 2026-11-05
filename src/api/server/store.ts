// Store reads shared by the read API builders: newest live versions, detections, links, and the
// layer to source mapping. Read-only: nothing here writes.
import type { InValue } from "@libsql/client";
import { config } from "../../../argus.config.ts";
import type { Db } from "../../db/client.ts";
import { rowToEvent } from "../../db/queries.ts";
import type { EventRecord, Kind, Source } from "../../events/types.ts";
import type { LayerId } from "../types.ts";

const COLUMNS =
  "id, record_key, source, kind, occurred_at, fetched_at, source_updated_at, lat, lon, min_lat, min_lon, max_lat, max_lon, title, facts, meta, raw, raw_gz, raw_digest, fetch_id, supersedes";
const COLUMNS_NO_RAW = COLUMNS.replace("raw, raw_gz", "NULL AS raw, NULL AS raw_gz");
/** SQLite binds at most 999 parameters in older builds; stay well under it. */
const CHUNK = 400;

/** Layer order used everywhere a payload lists layers. */
export const LAYER_IDS: readonly LayerId[] = ["quakes", "fires", "flights", "satellites", "events"];

/**
 * The source behind each layer and how often Argus fetches it. Flights use the layer poll
 * cadence: the layer is drawn from layer frames, not from the faster detector polls.
 */
export const LAYER_SOURCES: Record<LayerId, { source: Source; cadenceMs: number }> = {
  quakes: { source: "usgs", cadenceMs: config.cadence.usgsSeconds * 1000 },
  fires: { source: "firms", cadenceMs: config.cadence.firmsHeadSeconds * 1000 },
  flights: { source: "flights", cadenceMs: config.cadence.flightsLayerSeconds * 1000 },
  satellites: { source: "celestrak", cadenceMs: config.cadence.celestrakSeconds * 1000 },
  events: { source: "eonet", cadenceMs: config.cadence.eonetSeconds * 1000 },
};

/** Credit shown for events Argus computed itself (detections and aggregates). */
export const ARGUS_CREDIT = "Computed by Argus from the events it cites";

/** The on-screen credit for an event's source, from the layer that source feeds. */
export function creditFor(source: Source): string {
  if (source === "argus") return ARGUS_CREDIT;
  const layerId = LAYER_IDS.find((id) => LAYER_SOURCES[id].source === source);
  const layer = config.layers.find((l) => l.id === layerId);
  return layer ? layer.credit : ARGUS_CREDIT;
}

/** Same order as latestVersion(): fetched_at, then source_updated_at (null lowest), then id. */
export function isNewer(a: EventRecord, b: EventRecord): boolean {
  if (a.fetchedAt !== b.fetchedAt) return a.fetchedAt > b.fetchedAt;
  const ua = a.sourceUpdatedAt ?? -Infinity;
  const ub = b.sourceUpdatedAt ?? -Infinity;
  if (ua !== ub) return ua > ub;
  return a.id > b.id;
}

/** A record whose newest version is a tombstone or merge marker has ended. */
export function isEnded(e: EventRecord): boolean {
  return e.meta?.deleted === true;
}

/** The newest version per record key. */
export function newestPerRecord(events: EventRecord[]): EventRecord[] {
  const newest = new Map<string, EventRecord>();
  for (const e of events) {
    const prev = newest.get(e.recordKey);
    if (!prev || isNewer(e, prev)) newest.set(e.recordKey, e);
  }
  return [...newest.values()];
}

export interface NewestQuery {
  kind: Kind;
  /** Records with any version whose occurred_at is at or after this. */
  from?: number;
  /** Records with any version whose occurred_at is at or before this. */
  to?: number;
  /** Load raw and raw_gz too (list views leave them out). */
  withRaw?: boolean;
}

/**
 * The newest version of every record of a kind that has a version in the time range, with
 * ended records dropped. The newest version may itself lie outside the range (a revised origin
 * time), so callers still filter on occurredAt. Uses idx_events_kind_time and idx_events_record_key.
 */
export async function newestLiveVersions(db: Db, q: NewestQuery): Promise<EventRecord[]> {
  const where = ["kind = ?"];
  const args: InValue[] = [q.kind];
  if (q.from !== undefined) {
    where.push("occurred_at >= ?");
    args.push(q.from);
  }
  if (q.to !== undefined) {
    where.push("occurred_at <= ?");
    args.push(q.to);
  }
  const rs = await db.execute({
    sql: `SELECT ${q.withRaw ? COLUMNS : COLUMNS_NO_RAW} FROM events
          WHERE kind = ? AND record_key IN (SELECT record_key FROM events WHERE ${where.join(" AND ")})`,
    args: [q.kind, ...args],
  });
  return newestPerRecord(rs.rows.map(rowToEvent)).filter((e) => !isEnded(e));
}

/** Live detections of one detector whose newest version occurred in [from, to]. */
export async function liveDetections(
  db: Db,
  detector: string,
  from: number,
  to: number,
): Promise<EventRecord[]> {
  const found = await newestLiveVersions(db, { kind: "detection", from, to });
  return found.filter(
    (d) => d.meta?.detector === detector && d.occurredAt >= from && d.occurredAt <= to,
  );
}

/** Member ids per parent from event_links, in the order getLinks() returns them. */
export async function linksOf(db: Db, parentIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < parentIds.length; i += CHUNK) {
    const chunk = parentIds.slice(i, i + CHUNK);
    const rs = await db.execute({
      sql: `SELECT parent_id, child_id FROM event_links WHERE parent_id IN (${chunk
        .map(() => "?")
        .join(",")}) ORDER BY parent_id, child_id`,
      args: chunk,
    });
    for (const r of rs.rows) {
      const parent = String(r.parent_id);
      const list = out.get(parent);
      if (list) list.push(String(r.child_id));
      else out.set(parent, [String(r.child_id)]);
    }
  }
  return out;
}

/**
 * The version ids a set of detections cites, and the record keys of those versions, so a member
 * still counts after a newer version of it was stored.
 */
export async function linkedMembers(
  db: Db,
  parentIds: string[],
): Promise<{ ids: Set<string>; recordKeys: Set<string> }> {
  const ids = new Set<string>();
  const recordKeys = new Set<string>();
  for (let i = 0; i < parentIds.length; i += CHUNK) {
    const chunk = parentIds.slice(i, i + CHUNK);
    const rs = await db.execute({
      sql: `SELECT l.child_id, e.record_key FROM event_links l LEFT JOIN events e ON e.id = l.child_id
            WHERE l.parent_id IN (${chunk.map(() => "?").join(",")})`,
      args: chunk,
    });
    for (const r of rs.rows) {
      ids.add(String(r.child_id));
      if (r.record_key !== null) recordKeys.add(String(r.record_key));
    }
  }
  return { ids, recordKeys };
}
