// USGS real-time earthquake feed (docs/plan.md section 1a). One immutable version per
// (event, properties.updated). Identity is resolved through the `ids` alias list, because the
// preferred id can change, and a vanished event is only marked deleted after the FDSN event
// service answers 409 (USGS also drops duplicate solutions of real quakes from the feed).
import { config } from "../../../argus.config.ts";
import type { Db } from "../../db/client.ts";
import { getEvents, insertEvents, logFetchError, WriteBudgetExceeded } from "../../db/queries.ts";
import { label, upstream, utcDate, utcTime } from "../../events/facts.ts";
import type { EventRecord, Facts } from "../../events/types.ts";
import { sha256Hex } from "../../lib/digest.ts";
import { recordKeyOf, versionId } from "../../lib/ids.ts";
import { MS_PER_DAY, MS_PER_HOUR } from "../../lib/time.ts";
import { redactUrl, sourceFetch } from "../http.ts";
import type { RunDeps, SourceRunResult } from "../types.ts";

const SOURCE = "usgs";
/** FDSN checks are logged apart from the feed, so an expected 409 never marks the layer as failing. */
export const FDSN_LOG_SOURCE = "usgs-fdsn";
/** The feed is regenerated every 60 s (cache-control: max-age=60); a sooner fetch gets the same bytes. */
export const FEED_REFRESH_MS = 60_000;
export const MAX_FDSN_CHECKS_PER_RUN = 5;
export const FDSN_RECHECK_MS = MS_PER_HOUR;
/** all_day.geojson lists the past 24 h. */
const FEED_WINDOW_MS = MS_PER_DAY;
/** A record this close to the window's old edge may simply have aged out; never check it. */
const WINDOW_EDGE_MS = 15 * 60_000;
/** Stored records loaded for alias resolution and deletion checks (the retention window). */
const LOOKBACK_MS = config.retention.hours * MS_PER_HOUR;
const HEADERS = { "User-Agent": config.userAgent };

// ---------------------------------------------------------------------------------------------
// Normalizer (pure)

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** ",nc75440422,nn00924795," to ["nc75440422", "nn00924795"]. */
function splitList(v: unknown): string[] {
  return typeof v === "string" ? v.split(",").filter((s) => s.length > 0) : [];
}

/** Properties that are not citable facts; everything upstream stays in raw as well. */
const META_KEYS = [
  "net",
  "code",
  "tsunami",
  "sig",
  "felt",
  "cdi",
  "mmi",
  "alert",
  "nst",
  "dmin",
  "rms",
  "gap",
  "url",
] as const;

function normalizeFeature(
  feature: unknown,
  fetchedAt: number,
  fetchId: string,
): EventRecord | null {
  if (!isObj(feature) || !isObj(feature.properties) || !isObj(feature.geometry)) return null;
  const p = feature.properties;
  const coords = feature.geometry.coordinates;
  const nativeId = str(feature.id);
  const time = finite(p.time);
  const updated = finite(p.updated);
  if (!nativeId || time === null || updated === null || !Array.isArray(coords)) return null;
  const [lonRaw, latRaw, depthRaw] = coords as unknown[];
  const lon = finite(lonRaw);
  const lat = finite(latRaw);
  if (lat === null || lon === null) return null;

  const facts: Facts = {};
  const mag = finite(p.mag);
  if (mag !== null) facts.mag = upstream(mag);
  const magType = str(p.magType);
  if (magType) facts.mag_type = label(magType);
  // Depth can be negative (above the reference surface); it is kept as received.
  const depth = finite(depthRaw);
  if (depth !== null) facts.depth_km = upstream(depth, "km");
  const place = str(p.place);
  if (place) facts.place = label(place);
  facts.time = utcTime(time);
  facts.date = utcDate(time);
  const status = str(p.status);
  if (status) facts.status = label(status);
  const type = str(p.type);
  if (type) facts.type = label(type);

  const head = facts.mag ? `M ${facts.mag.text}` : "Magnitude not given";
  const ids = splitList(p.ids);
  if (!ids.includes(nativeId)) ids.unshift(nativeId);
  const meta: Record<string, unknown> = { ids, sources: splitList(p.sources) };
  for (const k of META_KEYS) meta[k] = p[k] ?? null;

  const raw = JSON.stringify(feature);
  return {
    id: versionId(SOURCE, nativeId, updated),
    recordKey: recordKeyOf(SOURCE, nativeId),
    source: SOURCE,
    kind: "earthquake",
    occurredAt: time,
    fetchedAt,
    sourceUpdatedAt: updated,
    lat,
    lon,
    bbox: null,
    title: place ? `${head}, ${place}` : head,
    facts,
    meta,
    raw,
    rawGz: null,
    rawDigest: sha256Hex(raw),
    fetchId,
    supersedes: null,
  };
}

/**
 * Turns an all_day GeoJSON FeatureCollection into event versions, one per feature, in feed
 * order. recordKey is the feature's own id here; runUsgs resolves aliases against the store.
 * Malformed features are skipped; a feed that is not a FeatureCollection throws.
 */
export function normalizeUsgsFeed(
  feed: unknown,
  fetchedAt: number,
  fetchId: string,
): EventRecord[] {
  if (!isObj(feed) || feed.type !== "FeatureCollection" || !Array.isArray(feed.features)) {
    throw new Error("USGS feed is not a GeoJSON FeatureCollection");
  }
  // One version per event: if a feed ever lists an id twice, the newest `updated` wins.
  const byNativeId = new Map<string, EventRecord>();
  for (const feature of feed.features) {
    const e = normalizeFeature(feature, fetchedAt, fetchId);
    if (!e) continue;
    const prev = byNativeId.get(e.recordKey);
    if (!prev || (e.sourceUpdatedAt ?? 0) > (prev.sourceUpdatedAt ?? 0)) {
      byNativeId.set(e.recordKey, e);
    }
  }
  return [...byNativeId.values()];
}

// ---------------------------------------------------------------------------------------------
// Store view

/** `usgs:nc75440422@1790191342331` or `usgs:nc75440422` to `nc75440422`. */
function nativeIdOf(idOrKey: string): string {
  const rest = idOrKey.slice(SOURCE.length + 1);
  const at = rest.lastIndexOf("@");
  return at === -1 ? rest : rest.slice(0, at);
}

function idsOf(e: EventRecord): string[] {
  const ids = e.meta?.ids;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
}

interface StoredRecord {
  key: string;
  latestId: string;
  latestFetchedAt: number;
  latestUpdatedAt: number | null;
  latestOccurredAt: number;
  /** False once the newest version is a tombstone or a merge marker. */
  live: boolean;
  /** Newest upstream `updated` over all versions (tombstones carry none). */
  maxUpdated: number | null;
  firstSeen: number;
  /** Every native id the record has been known by. */
  ids: Set<string>;
  versionIds: Set<string>;
}

const STORE_COLUMNS = "id, record_key, occurred_at, fetched_at, source_updated_at, meta";

function newer(fetchedAt: number, updatedAt: number | null, id: string, r: StoredRecord): boolean {
  // Same order as latestVersion(): fetched_at DESC, then source_updated_at DESC (nulls last).
  if (fetchedAt !== r.latestFetchedAt) return fetchedAt > r.latestFetchedAt;
  const a = updatedAt ?? -Infinity;
  const b = r.latestUpdatedAt ?? -Infinity;
  return a !== b ? a > b : id > r.latestId;
}

/**
 * Loads every version of the USGS records that could matter to this feed: those with an origin
 * time in the lookback window, plus any record keyed by one of the feed's ids.
 */
async function loadStore(
  db: Db,
  feedIds: Set<string>,
  now: number,
): Promise<Map<string, StoredRecord>> {
  const rows: Json[] = [];
  const windowed = await db.execute({
    sql: `SELECT ${STORE_COLUMNS} FROM events WHERE record_key IN (
            SELECT record_key FROM events WHERE kind = 'earthquake' AND occurred_at >= ? AND source = ?)`,
    args: [now - LOOKBACK_MS, SOURCE],
  });
  rows.push(...windowed.rows);
  const loaded = new Set(windowed.rows.map((r) => String(r.record_key)));
  const missing = [...feedIds].map((id) => recordKeyOf(SOURCE, id)).filter((k) => !loaded.has(k));
  for (let i = 0; i < missing.length; i += 400) {
    const chunk = missing.slice(i, i + 400);
    const rs = await db.execute({
      sql: `SELECT ${STORE_COLUMNS} FROM events WHERE record_key IN (${chunk.map(() => "?").join(",")})`,
      args: chunk,
    });
    rows.push(...rs.rows);
  }

  const store = new Map<string, StoredRecord>();
  for (const row of rows) {
    const id = String(row.id);
    const key = String(row.record_key);
    const fetchedAt = Number(row.fetched_at);
    const updatedAt = row.source_updated_at === null ? null : Number(row.source_updated_at);
    const meta = row.meta === null ? null : (JSON.parse(String(row.meta)) as Json);
    let r = store.get(key);
    if (!r) {
      r = {
        key,
        latestId: id,
        latestFetchedAt: fetchedAt,
        latestUpdatedAt: updatedAt,
        latestOccurredAt: Number(row.occurred_at),
        live: meta?.deleted !== true,
        maxUpdated: null,
        firstSeen: fetchedAt,
        ids: new Set([nativeIdOf(key)]),
        versionIds: new Set(),
      };
      store.set(key, r);
    } else if (newer(fetchedAt, updatedAt, id, r)) {
      r.latestId = id;
      r.latestFetchedAt = fetchedAt;
      r.latestUpdatedAt = updatedAt;
      r.latestOccurredAt = Number(row.occurred_at);
      r.live = meta?.deleted !== true;
    }
    if (r.versionIds.has(id)) continue;
    r.versionIds.add(id);
    r.firstSeen = Math.min(r.firstSeen, fetchedAt);
    if (updatedAt !== null) r.maxUpdated = Math.max(r.maxUpdated ?? updatedAt, updatedAt);
    r.ids.add(nativeIdOf(id));
    if (Array.isArray(meta?.ids)) for (const x of meta.ids) if (typeof x === "string") r.ids.add(x);
  }
  return store;
}

// ---------------------------------------------------------------------------------------------
// Identity resolution

interface Plan {
  /** New feed versions with their resolved recordKey and supersedes. */
  versions: EventRecord[];
  /** Record key each feed record resolved to. */
  keyOf: Map<EventRecord, string>;
  /** Live stored records whose ids now sit inside another record's event: key to absorbing record. */
  absorbed: Map<string, EventRecord>;
  stale: number;
}

/**
 * Resolves each feed record to a stored record key. A feature keeps its own key when that key is
 * stored; otherwise it takes the best stored record that shares one of its ids (live first, then
 * first seen), else starts a new key. No two features in one feed resolve to the same key.
 */
function resolve(records: EventRecord[], store: Map<string, StoredRecord>, now: number): Plan {
  const aliasIndex = new Map<string, string[]>();
  for (const r of store.values()) {
    for (const id of r.ids) aliasIndex.set(id, [...(aliasIndex.get(id) ?? []), r.key]);
  }
  const matched = new Map<EventRecord, Set<string>>();
  for (const e of records) {
    const keys = new Set<string>();
    for (const id of idsOf(e)) for (const k of aliasIndex.get(id) ?? []) keys.add(k);
    matched.set(e, keys);
  }

  const keyOf = new Map<EventRecord, string>();
  const claimed = new Set<string>();
  for (const e of records) {
    if (store.has(e.recordKey)) {
      keyOf.set(e, e.recordKey);
      claimed.add(e.recordKey);
    }
  }
  const rank = (a: StoredRecord, b: StoredRecord) =>
    Number(b.live) - Number(a.live) ||
    a.firstSeen - b.firstSeen ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  for (const e of records) {
    if (keyOf.has(e)) continue;
    const choices = [...(matched.get(e) ?? [])]
      .filter((k) => !claimed.has(k))
      .map((k) => store.get(k))
      .filter((r): r is StoredRecord => r !== undefined)
      .sort(rank);
    // The own key is free here: were it stored, the first pass would have claimed it.
    const key = choices[0]?.key ?? e.recordKey;
    keyOf.set(e, key);
    claimed.add(key);
  }

  const versions: EventRecord[] = [];
  let stale = 0;
  for (const e of records) {
    const key = keyOf.get(e) ?? e.recordKey;
    const prev = store.get(key);
    if (!prev) {
      versions.push({ ...e, recordKey: key });
      continue;
    }
    const updated = e.sourceUpdatedAt ?? 0;
    if (prev.maxUpdated !== null && updated < prev.maxUpdated) {
      stale += 1; // an older solution than one already stored (a lagging cache)
      continue;
    }
    let id = e.id;
    if (!prev.live && prev.versionIds.has(id)) {
      // Back in the feed unchanged after a tombstone or merge: a new version makes it live again.
      id = versionId(SOURCE, nativeIdOf(e.id), `${updated}-restored-${now}`);
    }
    if (prev.versionIds.has(id)) continue; // already stored
    versions.push({
      ...e,
      id,
      recordKey: key,
      supersedes: prev.latestId !== id ? prev.latestId : null,
    });
  }

  const absorbed = new Map<string, EventRecord>();
  for (const e of records) {
    for (const k of matched.get(e) ?? []) {
      if (!claimed.has(k) && !absorbed.has(k) && store.get(k)?.live) absorbed.set(k, e);
    }
  }
  return { versions, keyOf, absorbed, stale };
}

/** A version that ends a record: FDSN deleted it, or its ids now belong to another record. */
function endVersion(
  prev: EventRecord,
  id: string,
  status: "deleted" | "merged",
  raw: string,
  now: number,
  fetchId: string,
  extraMeta: Record<string, unknown>,
): EventRecord {
  return {
    ...prev,
    id,
    fetchedAt: now,
    sourceUpdatedAt: null,
    title: `${status === "deleted" ? "Deleted" : "Merged"}: ${prev.title}`,
    facts: { ...prev.facts, status: label(status) },
    meta: { ...prev.meta, deleted: true, ...extraMeta },
    raw,
    rawGz: null,
    rawDigest: sha256Hex(raw),
    fetchId,
    supersedes: prev.id,
  };
}

// ---------------------------------------------------------------------------------------------
// Deletion checks

function fdsnUrl(eventId: string): string {
  const u = new URL(config.sources.usgs.fdsnUrl);
  u.searchParams.set("eventid", eventId);
  u.searchParams.set("format", "geojson");
  return u.toString();
}

/** Event ids checked against FDSN within the last hour. Every check leaves a fetch_errors row. */
async function recentlyChecked(db: Db, now: number): Promise<Set<string>> {
  const rs = await db.execute({
    sql: "SELECT url FROM fetch_errors WHERE source = ? AND at > ?",
    args: [FDSN_LOG_SOURCE, now - FDSN_RECHECK_MS],
  });
  const out = new Set<string>();
  for (const r of rs.rows) {
    try {
      const id = new URL(String(r.url)).searchParams.get("eventid");
      if (id) out.add(id);
    } catch {
      // not a URL this module wrote
    }
  }
  return out;
}

function feedGeneratedAt(feed: unknown): number | null {
  return isObj(feed) && isObj(feed.metadata) ? finite(feed.metadata.generated) : null;
}

async function lastFeedOkAt(db: Db, now: number): Promise<number | null> {
  const hourStart = Math.floor(now / MS_PER_HOUR) * MS_PER_HOUR;
  const rs = await db.execute({
    sql: "SELECT MAX(last_ok_at) AS t FROM fetch_log WHERE source = ? AND hour_start >= ?",
    args: [SOURCE, hourStart - MS_PER_HOUR],
  });
  const t = rs.rows[0]?.t;
  return t === null || t === undefined ? null : Number(t);
}

// ---------------------------------------------------------------------------------------------
// Run

/**
 * One ingest pass: fetch the feed (at most once per 60 s), store new versions, end records whose
 * ids moved into another record, and confirm vanished records against FDSN (409 means deleted).
 */
export async function runUsgs(db: Db, deps: RunDeps): Promise<SourceRunResult> {
  const { now } = deps;
  const result = (
    status: SourceRunResult["status"],
    message: string,
    fetched = 0,
    inserted = 0,
  ): SourceRunResult => ({ source: SOURCE, fetched, inserted, status, message });

  const lastOk = await lastFeedOkAt(db, now);
  if (lastOk !== null && now - lastOk < FEED_REFRESH_MS) {
    return result("not_modified", "The feed refreshes every 60 s; the last fetch is still current");
  }

  const url = config.sources.usgs.url;
  let res: Response;
  try {
    res = await sourceFetch(db, SOURCE, url, { now, fetchImpl: deps.fetchImpl, headers: HEADERS });
  } catch (err) {
    return result("error", `Fetch failed: ${String(err)}`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    return result("error", `HTTP ${res.status}`);
  }
  const fetchId = `fetch:${SOURCE}:${now}`;
  let feed: unknown;
  let records: EventRecord[];
  try {
    feed = JSON.parse(await res.text());
    records = normalizeUsgsFeed(feed, now, fetchId);
  } catch (err) {
    const message = `Unreadable feed: ${String(err)}`;
    await logFetchError(db, SOURCE, url, res.status, message, now);
    return result("error", message);
  }
  const fetched = isObj(feed) && Array.isArray(feed.features) ? feed.features.length : 0;

  const feedIds = new Set(records.flatMap(idsOf));
  const store = await loadStore(db, feedIds, now);
  const plan = resolve(records, store, now);

  // Deletion checks: live records absent from the feed under every id they ever had, young
  // enough that they should still be in the 24 h window (which also means seen within 24 h),
  // not checked in the last hour, newest first, at most MAX_FDSN_CHECKS_PER_RUN.
  const claimedKeys = new Set(plan.keyOf.values());
  const cutoff = (feedGeneratedAt(feed) ?? now) - FEED_WINDOW_MS + WINDOW_EDGE_MS;
  const checked = await recentlyChecked(db, now);
  const toCheck = [...store.values()]
    .filter(
      (r) =>
        r.live &&
        !claimedKeys.has(r.key) &&
        r.latestOccurredAt >= cutoff &&
        ![...r.ids].some((id) => feedIds.has(id)) &&
        !checked.has(nativeIdOf(r.latestId)),
    )
    .sort((a, b) => b.latestOccurredAt - a.latestOccurredAt || (a.key < b.key ? -1 : 1))
    .slice(0, MAX_FDSN_CHECKS_PER_RUN);

  const absorbedKeys = [...plan.absorbed.keys()];
  const prevIds = [...absorbedKeys, ...toCheck.map((r) => r.key)]
    .map((k) => store.get(k)?.latestId)
    .filter((x): x is string => x !== undefined);
  const prevById = new Map((await getEvents(db, prevIds)).map((e) => [e.id, e]));
  const prevOf = (key: string) => prevById.get(store.get(key)?.latestId ?? "");

  const merged: EventRecord[] = [];
  for (const [key, into] of plan.absorbed) {
    const prev = prevOf(key);
    if (!prev || into.raw === null) continue;
    const id = versionId(SOURCE, nativeIdOf(prev.id), `merged-${now}`);
    const mergedInto = plan.keyOf.get(into);
    merged.push(endVersion(prev, id, "merged", into.raw, now, fetchId, { mergedInto }));
  }

  let inserted = 0;
  try {
    inserted += await insertEvents(db, [...plan.versions, ...merged], "ingest", now);
    const tombstones: EventRecord[] = [];
    for (const r of toCheck) {
      const prev = prevOf(r.key);
      if (!prev) continue;
      const eventId = nativeIdOf(prev.id);
      const checkUrl = fdsnUrl(eventId);
      let check: Response;
      try {
        check = await sourceFetch(db, FDSN_LOG_SOURCE, checkUrl, {
          now,
          fetchImpl: deps.fetchImpl,
          headers: HEADERS,
        });
      } catch {
        continue; // sourceFetch logged it, which also starts the hourly wait
      }
      if (check.status === 409) {
        const text = await check.text();
        const id = versionId(SOURCE, eventId, `deleted-${now}`);
        tombstones.push(endVersion(prev, id, "deleted", text, now, fetchId, {}));
        continue;
      }
      await check.body?.cancel();
      // sourceFetch logs every non-2xx answer to fetch_errors. Log a live answer as well, so
      // every check leaves the row that the hourly limit is derived from.
      if (check.ok) {
        const message = "Not deleted: the event is live upstream but missing from the feed";
        await logFetchError(db, FDSN_LOG_SOURCE, redactUrl(checkUrl), check.status, message, now);
      }
    }
    inserted += await insertEvents(db, tombstones, "ingest", now);
    return result(
      "ok",
      `${plan.versions.length} new versions, ${merged.length} merged, ${tombstones.length} deleted, ` +
        `${toCheck.length} FDSN checks, ${plan.stale} stale skipped`,
      fetched,
      inserted,
    );
  } catch (err) {
    if (err instanceof WriteBudgetExceeded) return result("error", err.message, fetched, inserted);
    throw err;
  }
}
