import { expect, test } from "@playwright/test";
import { config } from "../../argus.config.ts";
import { migrate, openDb, type Db } from "../../src/db/client.ts";
import { insertEvents, linkEvents } from "../../src/db/queries.ts";
import type { EventRecord, Kind, Source } from "../../src/events/types.ts";
import { applyRetention } from "../../src/ingest/retention.ts";
import { storePresence } from "../../src/ingest/sources/firms.ts";
import { sha256Hex } from "../../src/lib/digest.ts";
import { MS_PER_DAY, MS_PER_HOUR, utcDay } from "../../src/lib/time.ts";

// A day other than the machine's today, so the write guard row for retention stands alone.
const NOW = Date.UTC(2026, 9, 10, 12);
const OLD = NOW - 72 * MS_PER_HOUR; // past the 48 h cutoff
const FRESH = NOW - MS_PER_HOUR;
const SETUP = NOW - 10 * MS_PER_DAY; // write guard day used while inserting fixtures

async function freshDb(): Promise<Db> {
  const db = await openDb(":memory:");
  await migrate(db);
  return db;
}

/** A synthetic event version; only identity, kind, and times matter to retention. */
function ev(
  id: string,
  kind: Kind,
  occurredAt: number,
  fetchedAt: number,
  over: Partial<EventRecord> = {},
): EventRecord {
  const source = id.slice(0, id.indexOf(":")) as Source;
  const at = id.lastIndexOf("@");
  const raw = JSON.stringify({ id });
  return {
    id,
    recordKey: at > 0 ? id.slice(0, at) : id,
    source,
    kind,
    occurredAt,
    fetchedAt,
    sourceUpdatedAt: null,
    lat: null,
    lon: null,
    bbox: null,
    title: id,
    facts: {},
    meta: null,
    raw,
    rawGz: null,
    rawDigest: sha256Hex(raw),
    fetchId: null,
    supersedes: null,
    ...over,
  };
}

async function ids(db: Db): Promise<string[]> {
  const rs = await db.execute("SELECT id FROM events ORDER BY id");
  return rs.rows.map((r) => String(r.id));
}

async function count(db: Db, table: string): Promise<number> {
  const rs = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(rs.rows[0]?.n);
}

async function brief(db: Db, id: string, createdAt: number, bullets: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO briefs (id, created_at, window_start, window_end, input_digest, model, bullets,
            check_result, status) VALUES (?, ?, ?, ?, 'digest', 'model', ?, '{}', 'ok')`,
    args: [id, createdAt, createdAt - MS_PER_HOUR, createdAt, bullets],
  });
}

const bulletsCiting = (...eventIds: string[]) =>
  JSON.stringify(eventIds.map((id, i) => ({ text: `Bullet ${i + 1}.`, event_ids: [id] })));

test("retention keeps what is cited or protected and deletes the rest, charged to the guard", async () => {
  const db = await freshDb();
  const fireDate = (daysAgo: number) =>
    Date.parse(`${utcDay(NOW - daysAgo * MS_PER_DAY)}T00:00:00Z`);
  // fireDates + 1 acquisition dates, all past the cutoff, oldest first: the newest fireDates stay.
  const keepDates = config.retention.fireDates;
  const fireDays = Array.from({ length: keepDates + 1 }, (_, i) => keepDates + 3 - i);
  const events = [
    // Quakes: cited and old, uncited and old, old but fetched recently, recent.
    ev("usgs:cited@1", "earthquake", OLD, OLD),
    ev("usgs:uncited@1", "earthquake", OLD, OLD),
    ev("usgs:refetched@1", "earthquake", OLD, FRESH),
    ev("usgs:recent@1", "earthquake", FRESH, FRESH),
    // A cited version followed by a tombstone: deleting the tombstone would revive the record.
    ev("usgs:ended@1", "earthquake", OLD, OLD - MS_PER_HOUR),
    ev("usgs:ended@deleted", "earthquake", OLD, OLD, { meta: { deleted: true } }),
    // An old detection and its member go together; a recent detection keeps its old member.
    ev("argus:quake-cluster:old", "detection", OLD, OLD),
    ev("usgs:member-of-old@1", "earthquake", OLD, OLD),
    ev("argus:quake-cluster:new", "detection", FRESH, FRESH),
    ev("usgs:member-of-new@1", "earthquake", OLD, OLD),
    // Cited only by a brief that is itself past retention.
    ev("usgs:old-brief-only@1", "earthquake", OLD, OLD),
    // Fire batches for old acquisition dates: all but the oldest stay.
    ...fireDays.map((d) =>
      ev(`firms:N20:${utcDay(fireDate(d))}@1`, "fire_batch", fireDate(d), OLD),
    ),
    // Two old element sets of one satellite: the newest stays.
    ev("celestrak:25544@a", "satellite_elements", OLD - MS_PER_DAY, OLD - MS_PER_DAY),
    ev("celestrak:25544@b", "satellite_elements", OLD, OLD),
  ];
  await insertEvents(db, events, "ingest", SETUP);
  await linkEvents(db, "argus:quake-cluster:old", ["usgs:member-of-old@1"]);
  await linkEvents(db, "argus:quake-cluster:new", ["usgs:member-of-new@1"]);
  // A link whose parent is gone.
  await db.execute(
    "INSERT INTO event_links (parent_id, child_id) VALUES ('argus:gone', 'usgs:recent@1')",
  );

  await brief(db, "brief-kept", FRESH, bulletsCiting("usgs:cited@1", "usgs:ended@1"));
  await brief(db, "brief-old", OLD, bulletsCiting("usgs:old-brief-only@1"));

  // Bookkeeping tables: one old and one fresh row each.
  const today = Math.floor(NOW / MS_PER_DAY);
  const presenceDays = config.retention.firePresenceDays;
  await storePresence(
    db,
    [today - presenceDays - 1, today - presenceDays + 1].map((dayKey) => ({
      dayKey,
      satellite: "N20",
      subcells: new Map(),
    })),
    SETUP,
  );
  for (const [key, at] of [
    ["old", NOW - 49 * MS_PER_HOUR],
    ["fresh", FRESH],
  ] as const) {
    await db.execute({
      sql: "INSERT INTO model_cache (input_digest, route, model, response, created_at) VALUES (?, 'brief', 'm', '{}', ?)",
      args: [key, at],
    });
    await db.execute({
      sql: "INSERT INTO rate_limits (client_key, route, window_start, count) VALUES (?, 'ask', ?, 1)",
      args: [key, at],
    });
  }
  for (const at of [NOW - 8 * MS_PER_DAY, NOW - MS_PER_DAY]) {
    await db.execute({
      sql: "INSERT INTO fetch_log (source, hour_start, requests, bytes, last_status, last_ok_at) VALUES ('usgs', ?, 1, 0, 200, ?)",
      args: [at, at],
    });
    await db.execute({
      sql: "INSERT INTO fetch_errors (source, at, url, status, message) VALUES ('usgs', ?, 'https://example.invalid', 503, 'HTTP 503')",
      args: [at],
    });
  }

  const summary = await applyRetention(db, NOW);

  expect(await ids(db)).toEqual(
    [
      "usgs:cited@1",
      "usgs:refetched@1",
      "usgs:recent@1",
      "usgs:ended@1",
      "usgs:ended@deleted",
      "argus:quake-cluster:new",
      "usgs:member-of-new@1",
      ...fireDays.slice(1).map((d) => `firms:N20:${utcDay(fireDate(d))}@1`),
      "celestrak:25544@b",
    ].sort(),
  );
  expect(summary).toEqual({
    events: 6, // uncited, old detection, its member, old-brief-only, oldest fire date, older element set
    // cited, ended@1, ended@deleted, member-of-new, the kept fire dates, newest element set
    keptOld: 5 + keepDates,
    briefs: 1,
    firePresence: 1,
    modelCache: 1,
    rateLimits: 1,
    fetchLog: 1,
    fetchErrors: 1,
    links: 2, // the orphan, and the deleted detection's link
  });
  expect((await db.execute("SELECT id FROM briefs")).rows.map((r) => String(r.id))).toEqual([
    "brief-kept",
  ]);
  const links = await db.execute("SELECT parent_id, child_id FROM event_links");
  expect(links.rows.map((r) => [String(r.parent_id), String(r.child_id)])).toEqual([
    ["argus:quake-cluster:new", "usgs:member-of-new@1"],
  ]);
  for (const table of [
    "fire_presence",
    "model_cache",
    "rate_limits",
    "fetch_log",
    "fetch_errors",
  ]) {
    expect(await count(db, table)).toBe(1);
  }

  // Every deleted row was charged as billed writes on the retention day.
  const deletedRows = 6 + 1 + 1 + 1 + 1 + 1 + 1 + 2;
  const guard = await db.execute({
    sql: "SELECT billed_writes, ask_writes FROM write_budget WHERE day = ?",
    args: [utcDay(NOW)],
  });
  expect(guard.rows.map((r) => [Number(r.billed_writes), Number(r.ask_writes)])).toEqual([
    [deletedRows * config.writeGuard.indexFactor, 0],
  ]);

  // A second pass finds nothing more to delete.
  const again = await applyRetention(db, NOW);
  expect(again).toMatchObject({ events: 0, briefs: 0, links: 0 });
});

test("retention deletes no event when a kept brief's citations cannot be read", async () => {
  const db = await freshDb();
  await insertEvents(db, [ev("usgs:old@1", "earthquake", OLD, OLD)], "ingest", SETUP);
  await brief(db, "brief-broken", FRESH, "not json");
  await expect(applyRetention(db, NOW)).rejects.toThrow(/brief-broken.*not JSON/);
  expect(await ids(db)).toEqual(["usgs:old@1"]);
});

test("a detection cited by a kept brief keeps its members past retention", async () => {
  const db = await freshDb();
  await insertEvents(
    db,
    [
      ev("argus:circling:episode@1", "detection", OLD, OLD),
      ev("flights:track:episode@1", "aircraft_track", OLD, OLD),
    ],
    "ingest",
    SETUP,
  );
  await linkEvents(db, "argus:circling:episode@1", ["flights:track:episode@1"]);
  await brief(db, "brief-kept", FRESH, bulletsCiting("argus:circling:episode@1"));
  expect(await applyRetention(db, NOW)).toMatchObject({ events: 0, keptOld: 2, links: 0 });
  expect(await ids(db)).toEqual(["argus:circling:episode@1", "flights:track:episode@1"]);
});
