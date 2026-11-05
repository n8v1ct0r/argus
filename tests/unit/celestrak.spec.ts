import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { json2satrec, propagate, type OMMJsonObject } from "satellite.js";
import { migrate, openDb, type Db } from "../../src/db/client.ts";
import { getBackoff, getEvents, listEvents, sourceHealth } from "../../src/db/queries.ts";
import type { EventRecord } from "../../src/events/types.ts";
import type { FetchImpl } from "../../src/ingest/types.ts";
import {
  celestrakUrl,
  normalizeElementSets,
  parseOmmCsv,
  runCelestrak,
} from "../../src/ingest/sources/celestrak.ts";
import { sha256Hex } from "../../src/lib/digest.ts";
import { MS_PER_HOUR } from "../../src/lib/time.ts";

// Trimmed from real CelesTrak responses (GROUP=stations and GROUP=visual, FORMAT=csv,
// 2026-09-24 02:04 UTC): 8 and 5 rows, CRLF line endings as served, 3 satellites in both groups.
const STATIONS = readFileSync(
  new URL("../fixtures/celestrak/stations_sample.csv", import.meta.url),
  "utf8",
);
const VISUAL = readFileSync(
  new URL("../fixtures/celestrak/visual_sample.csv", import.meta.url),
  "utf8",
);

const NOW = Date.UTC(2026, 8, 24, 2, 4, 12);
const ISS_ID = "celestrak:25544@2026-09-23T10:22:36.196896Z";
const EXPECTED_UA = "Argus/0.1 (+https://github.com/n8v1ct0r)";

async function freshDb(): Promise<Db> {
  const db = await openDb(":memory:");
  await migrate(db);
  return db;
}

type Reply = { status: number; body: string } | Error;

/** A fetch that answers per GROUP and records every call, so tests can count requests. */
function fakeFetch(reply: (group: string) => Reply) {
  const calls: { url: string; userAgent: string | null }[] = [];
  const impl: FetchImpl = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, userAgent: new Headers(init?.headers).get("User-Agent") });
    const r = reply(new URL(url).searchParams.get("GROUP") ?? "");
    if (r instanceof Error) throw r;
    return new Response(r.body, {
      status: r.status,
      headers: { "content-length": String(Buffer.byteLength(r.body)) },
    });
  };
  return { impl, calls };
}

const fixtures = (group: string): Reply =>
  group === "stations"
    ? { status: 200, body: STATIONS }
    : group === "visual"
      ? { status: 200, body: VISUAL }
      : { status: 404, body: "" };

test("parseOmmCsv reads a real response with CRLF endings and 6-digit catalog numbers", () => {
  const rows = parseOmmCsv(STATIONS);
  expect(rows).toHaveLength(8);
  const iss = rows[0];
  expect(iss?.OBJECT_NAME).toBe("ISS (ZARYA)");
  expect(iss?.EPOCH).toBe("2026-09-23T10:22:36.196896");
  expect(iss?.BSTAR).toBe(".1642946E-3");
  // The last column must not carry the carriage return.
  expect(rows.map((r) => r.MEAN_MOTION_DDOT)).toContain(".38653276E-4");
  expect(rows.every((r) => !Object.values(r).some((v) => v.includes("\r")))).toBe(true);
  expect(rows.map((r) => r.NORAD_CAT_ID)).toEqual(expect.arrayContaining(["100057", "100712"]));
  expect(Object.keys(iss ?? {})).toHaveLength(17);
});

test("parseOmmCsv handles quotes, a BOM, blank lines, and drops rows it cannot align", () => {
  const bom = String.fromCharCode(0xfeff);
  const text =
    bom +
    'OBJECT_NAME,NORAD_CAT_ID,EPOCH\n"SAT, WITH COMMA",1,2026-01-01T00:00:00\n\n' +
    '"SAY ""HI""",2,2026-01-01T00:00:00\nTOO,MANY,FIELDS,HERE\nNO NEWLINE AT END,3,x';
  const rows = parseOmmCsv(text);
  expect(rows.map((r) => r.OBJECT_NAME)).toEqual([
    "SAT, WITH COMMA",
    'SAY "HI"',
    "NO NEWLINE AT END",
  ]);
  expect(rows[0]?.NORAD_CAT_ID).toBe("1");
  expect(parseOmmCsv("")).toEqual([]);
});

test("normalizeElementSets builds one immutable version per element set", () => {
  const rows = parseOmmCsv(STATIONS);
  const events = normalizeElementSets(rows, "stations", NOW, "fetch-1");
  expect(events).toHaveLength(8);
  const iss = events.find((e) => e.recordKey === "celestrak:25544");
  expect(iss?.id).toBe(ISS_ID);
  expect(iss?.kind).toBe("satellite_elements");
  expect(iss?.source).toBe("celestrak");
  expect(iss?.occurredAt).toBe(Date.UTC(2026, 8, 23, 10, 22, 36, 196));
  expect(iss?.fetchedAt).toBe(NOW);
  expect(iss?.fetchId).toBe("fetch-1");
  expect(iss?.lat).toBeNull();
  expect(iss?.lon).toBeNull();
  expect(iss?.bbox).toBeNull();
  expect(iss?.supersedes).toBeNull();
  expect(iss?.title).toBe("Orbital elements for ISS (ZARYA)");
  expect(iss?.meta).toEqual({ groups: ["stations"], object_id: "1998-067A" });

  const texts = Object.fromEntries(Object.entries(iss?.facts ?? {}).map(([k, f]) => [k, f.text]));
  expect(texts).toEqual({
    name: "ISS (ZARYA)",
    norad: "25544",
    epoch: "2026-09-23",
    epoch_time: "10:22 UTC",
    inclination_deg: "51.6317",
    mean_motion: "15.49245192",
  });
  // Thresholds and designators are metadata, never citable facts.
  expect(Object.keys(iss?.facts ?? {})).not.toContain("object_id");

  // raw is the OMM row with every keyword and the CSV strings untouched; the digest covers it.
  expect(JSON.parse(iss?.raw ?? "null")).toEqual(rows[0]);
  expect(iss?.rawGz).toBeNull();
  expect(iss?.rawDigest).toBe(sha256Hex(iss?.raw ?? ""));

  // 6-digit catalog numbers keep every digit in id, record key, and facts.
  const soyuz = events.find((e) => e.facts.name?.text === "SOYUZ-MS 29");
  expect(soyuz?.id).toBe("celestrak:100057@2026-09-23T10:22:36.196896Z");
  expect(soyuz?.recordKey).toBe("celestrak:100057");
  expect(soyuz?.facts.norad?.text).toBe("100057");
});

test("normalizeElementSets skips rows satellite.js could not propagate, and duplicates", () => {
  const [good] = parseOmmCsv(STATIONS);
  if (!good) throw new Error("fixture is empty");
  const rows = [
    good,
    { ...good },
    { ...good, NORAD_CAT_ID: "" },
    { ...good, NORAD_CAT_ID: "25544A" },
    { ...good, NORAD_CAT_ID: "5", EPOCH: "2026-13-01T00:00:00" },
    { ...good, NORAD_CAT_ID: "6", EPOCH: "not a date" },
    { ...good, NORAD_CAT_ID: "7", BSTAR: "" },
    { ...good, NORAD_CAT_ID: "8", MEAN_MOTION: "fast" },
    { ...good, NORAD_CAT_ID: "9", EPHEMERIS_TYPE: "4" },
    { ...good, NORAD_CAT_ID: "10", OBJECT_NAME: "  " },
    { ...good, NORAD_CAT_ID: "11", EPOCH: "2026-09-23T10:22:36Z" },
  ];
  const events = normalizeElementSets(rows, "stations", NOW, null);
  expect(events.map((e) => e.id)).toEqual([ISS_ID, "celestrak:11@2026-09-23T10:22:36Z"]);
});

test("titles follow the copy rules", () => {
  const events = [
    ...normalizeElementSets(parseOmmCsv(STATIONS), "stations", NOW, null),
    ...normalizeElementSets(parseOmmCsv(VISUAL), "visual", NOW, null),
  ];
  // En and em dash, written as code points so this file carries neither character.
  const dashes = [0x2013, 0x2014].map((c) => String.fromCharCode(c));
  for (const e of events) {
    expect(e.title.startsWith("Orbital elements for ")).toBe(true);
    for (const dash of dashes) expect(e.title).not.toContain(dash);
  }
});

test("satellite.js json2satrec accepts the stored raw row and propagates at the epoch", () => {
  const events = [
    ...normalizeElementSets(parseOmmCsv(STATIONS), "stations", NOW, null),
    ...normalizeElementSets(parseOmmCsv(VISUAL), "visual", NOW, null),
  ];
  expect(events).toHaveLength(13);
  for (const e of events) {
    const omm = JSON.parse(e.raw ?? "null") as OMMJsonObject;
    const satrec = json2satrec(omm);
    expect(satrec.error).toBe(0);
    expect(satrec.satnum).toBe(e.facts.norad?.text);
    const pv = propagate(satrec, new Date(e.occurredAt));
    expect(pv).not.toBeNull();
    const { x, y, z } = pv?.position ?? { x: NaN, y: NaN, z: NaN };
    const radiusKm = Math.hypot(x, y, z);
    expect(Number.isFinite(radiusKm)).toBe(true);
    // Every object in the samples is in Earth orbit: above the surface, well inside the Moon.
    expect(radiusKm).toBeGreaterThan(6378);
    expect(radiusKm).toBeLessThan(50_000);
  }
  // The ISS sits at a low Earth orbit radius (Earth radius plus about 400 km).
  const iss = events.find((e) => e.id === ISS_ID);
  const pv = propagate(json2satrec(JSON.parse(iss?.raw ?? "null")), new Date(iss?.occurredAt ?? 0));
  const r = Math.hypot(pv?.position.x ?? 0, pv?.position.y ?? 0, pv?.position.z ?? 0);
  expect(r).toBeGreaterThan(6600);
  expect(r).toBeLessThan(6900);
});

test("celestrakUrl asks for CSV over https and refuses the heavy groups", () => {
  expect(celestrakUrl("stations")).toBe(
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=csv",
  );
  expect(() => celestrakUrl("active")).toThrow();
  expect(() => celestrakUrl("STARLINK")).toThrow();
});

test("runCelestrak fetches each group once, dedupes the overlap, and is idempotent", async () => {
  const db = await freshDb();
  const { impl, calls } = fakeFetch(fixtures);
  const result = await runCelestrak(db, { now: NOW, fetchImpl: impl });
  expect(result.status).toBe("ok");
  expect(result.source).toBe("celestrak");
  // 8 stations rows plus 5 visual rows, 3 of them the same element sets.
  expect(result.fetched).toBe(10);
  expect(result.inserted).toBe(10);
  expect(calls.map((c) => c.url)).toEqual([
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=csv",
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=csv",
  ]);
  expect(calls.every((c) => c.userAgent === EXPECTED_UA)).toBe(true);

  const stored = await listEvents(db, { kinds: ["satellite_elements"] });
  expect(stored).toHaveLength(10);
  const groupsOf = (e: EventRecord | undefined) => e?.meta?.groups;
  const byNorad = (n: string) => stored.find((e) => e.recordKey === `celestrak:${n}`);
  expect(groupsOf(byNorad("25544"))).toEqual(["stations", "visual"]);
  expect(groupsOf(byNorad("48274"))).toEqual(["stations", "visual"]);
  expect(groupsOf(byNorad("66515"))).toEqual(["stations", "visual"]);
  expect(groupsOf(byNorad("20580"))).toEqual(["visual"]);
  expect(groupsOf(byNorad("100712"))).toEqual(["stations"]);
  expect(byNorad("25544")?.supersedes).toBeNull();
  expect(await getBackoff(db, "celestrak")).toBeNull();
  expect((await sourceHealth(db)).celestrak?.lastOkAt).toBe(NOW);

  // Within the 2 h update interval: no request at all.
  const early = await runCelestrak(db, { now: NOW + MS_PER_HOUR, fetchImpl: impl });
  expect(early.status).toBe("skipped_backoff");
  expect(calls).toHaveLength(2);

  // Next scheduled run, same upstream data: 2 requests, 0 new versions.
  const again = await runCelestrak(db, { now: NOW + 6 * MS_PER_HOUR, fetchImpl: impl });
  expect(again.status).toBe("ok");
  expect(again.inserted).toBe(0);
  expect(calls).toHaveLength(4);
  expect(await listEvents(db, { kinds: ["satellite_elements"] })).toHaveLength(10);
});

test("a new epoch is a new version that supersedes the stored one", async () => {
  const db = await freshDb();
  await runCelestrak(db, { now: NOW, fetchImpl: fakeFetch(fixtures).impl });
  const newEpoch = "2026-09-23T22:01:02.123456";
  const updated = (group: string): Reply => {
    const r = fixtures(group);
    if (r instanceof Error) return r;
    return { ...r, body: r.body.replace(/(ISS \(ZARYA\),1998-067A,)[^,]+/, `$1${newEpoch}`) };
  };
  const later = NOW + 6 * MS_PER_HOUR;
  const result = await runCelestrak(db, { now: later, fetchImpl: fakeFetch(updated).impl });
  expect(result.status).toBe("ok");
  expect(result.inserted).toBe(1);
  const [next] = await getEvents(db, [`celestrak:25544@${newEpoch}Z`]);
  expect(next?.supersedes).toBe(ISS_ID);
  expect(next?.meta?.groups).toEqual(["stations", "visual"]);
  expect(next?.facts.epoch_time?.text).toBe("22:01 UTC");
  // The first version is untouched.
  const [first] = await getEvents(db, [ISS_ID]);
  expect(first?.fetchedAt).toBe(NOW);
});

test("a non-200 stops the run at once, stores nothing, and backs off 2 h up to 12 h", async () => {
  const db = await freshDb();
  const { impl, calls } = fakeFetch(() => ({ status: 403, body: "Forbidden" }));
  const result = await runCelestrak(db, { now: NOW, fetchImpl: impl });
  expect(result.status).toBe("error");
  expect(result.message).toContain("HTTP 403");
  // No retry and no second group after the first failure.
  expect(calls).toHaveLength(1);
  expect(await listEvents(db, { kinds: ["satellite_elements"] })).toHaveLength(0);
  const backoff = await getBackoff(db, "celestrak");
  expect(backoff).toEqual({ failures: 1, nextAllowedAt: NOW + 2 * MS_PER_HOUR, lastStatus: 403 });

  // While backing off: skipped with no request.
  const skipped = await runCelestrak(db, { now: NOW + MS_PER_HOUR, fetchImpl: impl });
  expect(skipped.status).toBe("skipped_backoff");
  expect(calls).toHaveLength(1);

  // Each further failure doubles the wait, capped at 12 h.
  let now = NOW;
  const waits: number[] = [];
  for (let i = 0; i < 4; i++) {
    now = (await getBackoff(db, "celestrak"))?.nextAllowedAt ?? now;
    await runCelestrak(db, { now, fetchImpl: impl });
    waits.push(((await getBackoff(db, "celestrak"))?.nextAllowedAt ?? 0) - now);
  }
  expect(waits.map((w) => w / MS_PER_HOUR)).toEqual([4, 8, 12, 12]);
  expect(calls).toHaveLength(5);
});

test("a failure on the second group stores nothing from the first", async () => {
  const db = await freshDb();
  const { impl, calls } = fakeFetch((g) =>
    g === "visual" ? { status: 500, body: "" } : fixtures(g),
  );
  const result = await runCelestrak(db, { now: NOW, fetchImpl: impl });
  expect(result.status).toBe("error");
  expect(calls).toHaveLength(2);
  expect(await listEvents(db, { kinds: ["satellite_elements"] })).toHaveLength(0);
  expect((await getBackoff(db, "celestrak"))?.lastStatus).toBe(500);
});

test("network errors and empty 200 bodies also stop the run and back off", async () => {
  const db = await freshDb();
  const down = fakeFetch(() => new Error("connect ECONNREFUSED"));
  const result = await runCelestrak(db, { now: NOW, fetchImpl: down.impl });
  expect(result.status).toBe("error");
  expect(down.calls).toHaveLength(1);
  expect(await getBackoff(db, "celestrak")).toMatchObject({ failures: 1, lastStatus: null });

  const db2 = await freshDb();
  const empty = fakeFetch(() => ({ status: 200, body: "No GP data found" }));
  const result2 = await runCelestrak(db2, { now: NOW, fetchImpl: empty.impl });
  expect(result2.status).toBe("error");
  expect(empty.calls).toHaveLength(1);
  expect(await getBackoff(db2, "celestrak")).toMatchObject({ failures: 1, lastStatus: 200 });
  expect(await listEvents(db2, { kinds: ["satellite_elements"] })).toHaveLength(0);
});
