// CelesTrak GP element sets for the satellites layer (docs/plan.md section 1b).
//
// One GET per configured group, CSV with OMM keywords (never TLE, which drops 6-digit catalog
// numbers). CelesTrak's rules: download once per 2 h update, stop on any non-200, and 50 errors
// in 2 h firewall the IP. So a run is all or nothing: every group must return 200 with usable
// element sets before anything is stored, the first failure stops the run and starts a persisted
// backoff, and nothing retries inside a run. Argus stores element sets, never positions; the
// browser passes `raw` to satellite.js json2satrec and propagates it.
import { config } from "../../../argus.config.ts";
import type { Db } from "../../db/client.ts";
import {
  getBackoff,
  insertEvents,
  latestVersion,
  logFetchError,
  recordFailure,
  recordSuccess,
  sourceHealth,
  WriteBudgetExceeded,
} from "../../db/queries.ts";
import { label, upstream, utcDate, utcTime } from "../../events/facts.ts";
import type { EventRecord } from "../../events/types.ts";
import { sha256Hex } from "../../lib/digest.ts";
import { recordKeyOf, versionId } from "../../lib/ids.ts";
import { MS_PER_HOUR } from "../../lib/time.ts";
import { sourceFetch } from "../http.ts";
import type { RunDeps, SourceRunResult } from "../types.ts";

const SOURCE = "celestrak";

// Proposed config keys (see the module report); kept local because argus.config.ts is shared.
const USER_AGENT = config.userAgent;
/** CelesTrak rebuilds GP data every 2 hours, so a sooner download can only repeat the last one. */
const MIN_INTERVAL_MS = 2 * MS_PER_HOUR;
const BACKOFF_BASE_MS = 2 * MS_PER_HOUR;
const BACKOFF_MAX_MS = 12 * MS_PER_HOUR;
/** Heavy groups: a repeat download returns 403, and 403s count toward the firewall. */
const FORBIDDEN_GROUPS = new Set(["active", "starlink"]);

/** Numeric OMM keywords that satellite.js json2satrec reads, plus the ones Argus cites. */
const NUMERIC_KEYWORDS = [
  "MEAN_MOTION",
  "ECCENTRICITY",
  "INCLINATION",
  "RA_OF_ASC_NODE",
  "ARG_OF_PERICENTER",
  "MEAN_ANOMALY",
  "BSTAR",
  "MEAN_MOTION_DOT",
  "MEAN_MOTION_DDOT",
] as const;

const BYTE_ORDER_MARK = 0xfeff;
const NORAD_PATTERN = /^\d{1,9}$/;
const EPOCH_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z?$/;

/** The GP query URL for one group. Always an explicit FORMAT; never the heavy groups. */
export function celestrakUrl(group: string): string {
  if (FORBIDDEN_GROUPS.has(group.trim().toLowerCase())) {
    throw new Error(`Argus never requests GROUP=${group} from CelesTrak`);
  }
  return `${config.sources.celestrak.url}?GROUP=${encodeURIComponent(group)}&FORMAT=csv`;
}

/**
 * Parses a CelesTrak OMM CSV response (RFC 4180: quoted fields, doubled quotes, CRLF or LF) into
 * one record per row, keyed by the header. Values stay exactly as written in the CSV. Blank lines
 * are skipped, and a row whose field count differs from the header is dropped rather than guessed.
 */
export function parseOmmCsv(text: string): Record<string, string>[] {
  const records = parseCsvRecords(text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text);
  const header = records.shift();
  if (!header) return [];
  const names = header.map((name) => name.trim());
  const rows: Record<string, string>[] = [];
  for (const fields of records) {
    if (fields.length === 1 && fields[0] === "") continue;
    if (fields.length !== names.length) continue;
    const row: Record<string, string> = {};
    names.forEach((name, i) => {
      row[name] = fields[i] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let atFieldStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
      continue;
    }
    if (ch === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
      atFieldStart = true;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      fields.push(field);
      records.push(fields);
      fields = [];
      field = "";
      atFieldStart = true;
    } else {
      field += ch;
      atFieldStart = false;
    }
  }
  if (field !== "" || fields.length > 0) {
    fields.push(field);
    records.push(fields);
  }
  return records;
}

/** Epoch "YYYY-MM-DDTHH:MM:SS[.ffffff][Z]" (UTC) to epoch milliseconds, or null if invalid. */
function parseEpochMs(epoch: string): number | null {
  const m = EPOCH_PATTERN.exec(epoch);
  if (!m) return null;
  const [, year, month, day, hour, minute, second, fraction = ""] = m;
  const whole = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  if (!Number.isFinite(whole)) return null;
  // Date.UTC rolls month 13 or hour 25 over silently; a round trip rejects them.
  if (new Date(whole).toISOString().slice(0, 19) !== epoch.slice(0, 19)) return null;
  return whole + Number(fraction.padEnd(3, "0").slice(0, 3));
}

function isNumeric(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "" && Number.isFinite(Number(value));
}

function toEvent(
  row: Record<string, string>,
  group: string,
  fetchedAt: number,
  fetchId: string | null,
): EventRecord | null {
  const norad = row.NORAD_CAT_ID;
  const epoch = row.EPOCH;
  const name = row.OBJECT_NAME?.trim();
  if (!norad || !NORAD_PATTERN.test(norad) || !epoch || !name) return null;
  if (!NUMERIC_KEYWORDS.every((k) => isNumeric(row[k]))) return null;
  // satellite.js propagates SGP4 element sets only (ephemeris type 0); SGP4-XP sets would be wrong.
  if (row.EPHEMERIS_TYPE !== undefined && row.EPHEMERIS_TYPE.trim() !== "0") return null;
  const epochMs = parseEpochMs(epoch);
  if (epochMs === null) return null;

  const raw = JSON.stringify(row);
  return {
    id: versionId(SOURCE, norad, epoch.endsWith("Z") ? epoch : `${epoch}Z`),
    recordKey: recordKeyOf(SOURCE, norad),
    source: SOURCE,
    kind: "satellite_elements",
    occurredAt: epochMs,
    fetchedAt,
    // CelesTrak publishes no revision time; a newer element set always has a newer epoch.
    sourceUpdatedAt: epochMs,
    lat: null,
    lon: null,
    bbox: null,
    title: `Orbital elements for ${name}`,
    facts: {
      name: label(name),
      norad: label(norad),
      epoch: utcDate(epochMs),
      epoch_time: utcTime(epochMs),
      inclination_deg: upstream(row.INCLINATION ?? "", "deg"),
      mean_motion: upstream(row.MEAN_MOTION ?? "", "rev/day"),
    },
    meta: { groups: [group], object_id: row.OBJECT_ID ?? null },
    raw,
    rawGz: null,
    rawDigest: sha256Hex(raw),
    fetchId,
    supersedes: null,
  };
}

/**
 * One immutable version per (NORAD_CAT_ID, EPOCH) for one group's rows. Rows that satellite.js
 * could not propagate (missing or non-numeric elements, a bad epoch, a non-SGP4 ephemeris type)
 * are skipped. Pure: supersedes stays null until the run links versions against the store.
 */
export function normalizeElementSets(
  rows: Record<string, string>[],
  group: string,
  fetchedAt: number,
  fetchId: string | null,
): EventRecord[] {
  const seen = new Set<string>();
  const events: EventRecord[] = [];
  for (const row of rows) {
    const event = toEvent(row, group, fetchedAt, fetchId);
    if (!event || seen.has(event.id)) continue;
    seen.add(event.id);
    events.push(event);
  }
  return events;
}

function groupsOf(event: EventRecord): string[] {
  const groups = event.meta?.groups;
  return Array.isArray(groups) ? groups.map(String) : [];
}

/**
 * Groups overlap (the ISS is in both stations and visual), so the same element set arrives more
 * than once. Keep the first row per version id, and list on every version all the groups its
 * satellite appeared in during this run, in config order.
 */
function mergeGroups(batches: EventRecord[][]): EventRecord[] {
  const byId = new Map<string, EventRecord>();
  const groupsByKey = new Map<string, string[]>();
  for (const event of batches.flat()) {
    const groups = groupsByKey.get(event.recordKey) ?? [];
    for (const g of groupsOf(event)) if (!groups.includes(g)) groups.push(g);
    groupsByKey.set(event.recordKey, groups);
    if (!byId.has(event.id)) byId.set(event.id, event);
  }
  return [...byId.values()].map((event) => ({
    ...event,
    meta: { ...event.meta, groups: groupsByKey.get(event.recordKey) ?? [] },
  }));
}

/** Points each new version at the version it replaces: the stored latest, then earlier new ones. */
async function linkSupersedes(db: Db, events: EventRecord[]): Promise<EventRecord[]> {
  const byKey = new Map<string, EventRecord[]>();
  for (const event of events) {
    byKey.set(event.recordKey, [...(byKey.get(event.recordKey) ?? []), event]);
  }
  const linked: EventRecord[] = [];
  for (const [recordKey, versions] of byKey) {
    let previous = (await latestVersion(db, recordKey))?.id ?? null;
    for (const event of versions.sort((a, b) => a.occurredAt - b.occurredAt)) {
      linked.push(previous === event.id ? event : { ...event, supersedes: previous });
      previous = event.id;
    }
  }
  return linked;
}

async function fail(
  db: Db,
  status: number | null,
  message: string,
  now: number,
): Promise<SourceRunResult> {
  const backoff = await recordFailure(db, SOURCE, status, BACKOFF_BASE_MS, BACKOFF_MAX_MS, now);
  return {
    source: SOURCE,
    fetched: 0,
    inserted: 0,
    status: "error",
    message: `${message}. Stopped; next try after ${new Date(backoff.nextAllowedAt).toISOString()}`,
  };
}

/** Fetches every configured group once and stores new element-set versions. */
export async function runCelestrak(db: Db, deps: RunDeps): Promise<SourceRunResult> {
  const { now, fetchImpl } = deps;
  const skipped = (message: string): SourceRunResult => ({
    source: SOURCE,
    fetched: 0,
    inserted: 0,
    status: "skipped_backoff",
    message,
  });

  const backoff = await getBackoff(db, SOURCE);
  if (backoff && backoff.nextAllowedAt > now) {
    return skipped(`Backing off until ${new Date(backoff.nextAllowedAt).toISOString()}`);
  }
  const lastOkAt = (await sourceHealth(db))[SOURCE]?.lastOkAt ?? null;
  if (lastOkAt !== null && now - lastOkAt < MIN_INTERVAL_MS) {
    return skipped("Last download was under 2 hours ago, and CelesTrak updates every 2 hours");
  }

  const batches: EventRecord[][] = [];
  const counts: string[] = [];
  for (const group of config.sources.celestrak.groups) {
    const url = celestrakUrl(group);
    let status: number;
    let text: string;
    try {
      const res = await sourceFetch(db, SOURCE, url, {
        now,
        fetchImpl,
        headers: { "User-Agent": USER_AGENT },
      });
      status = res.status;
      if (status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        return await fail(db, status, `HTTP ${status} for GROUP=${group}`, now);
      }
      text = await res.text();
    } catch (err) {
      return await fail(db, null, `Request for GROUP=${group} failed: ${String(err)}`, now);
    }
    const rows = parseOmmCsv(text);
    const events = normalizeElementSets(rows, group, now, `${SOURCE}:${group}@${now}`);
    if (!events.length) {
      const message = `HTTP 200 for GROUP=${group} held no usable element sets`;
      await logFetchError(db, SOURCE, url, status, message, now);
      return await fail(db, status, message, now);
    }
    batches.push(events);
    counts.push(`${group}: ${events.length} of ${rows.length} rows`);
  }
  await recordSuccess(db, SOURCE);

  const events = await linkSupersedes(db, mergeGroups(batches));
  try {
    const inserted = await insertEvents(db, events, "ingest", now);
    return {
      source: SOURCE,
      fetched: events.length,
      inserted,
      status: "ok",
      message: counts.join(", "),
    };
  } catch (err) {
    if (!(err instanceof WriteBudgetExceeded)) throw err;
    return {
      source: SOURCE,
      fetched: events.length,
      inserted: 0,
      status: "error",
      message: err.message,
    };
  }
}
