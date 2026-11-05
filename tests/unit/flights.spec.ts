import { expect, test } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../argus.config.ts";
import { migrate, openDb, type Db } from "../../src/db/client.ts";
import { getBackoff, getEvents, insertEvents, listEvents } from "../../src/db/queries.ts";
import type { FlightSample } from "../../src/detectors/types.ts";
import { utcTime } from "../../src/events/facts.ts";
import { opaqueKey, sha256Hex } from "../../src/lib/digest.ts";
import { gunzipText } from "../../src/lib/gzip.ts";
import type {
  Clock,
  FlightArea,
  FlightProvider,
} from "../../src/ingest/sources/flights/adapter.ts";
import {
  adsbLolPointUrl,
  assertPointEndpoint,
  createAdsbLolProvider,
} from "../../src/ingest/sources/flights/adsblol.ts";
import {
  buildAircraftTrack,
  buildDetectorBatch,
  buildLayerFrame,
} from "../../src/ingest/sources/flights/frames.ts";
import { redactAircraft, redactAll } from "../../src/ingest/sources/flights/redact.ts";
import { runFlightsDetectorSample, runFlightsLayer } from "../../src/ingest/sources/flights/run.ts";
import { aircraftId, createAircraftIdentity } from "../../src/ingest/sources/flights/salt.ts";
import type { FetchImpl } from "../../src/ingest/types.ts";

// Synthetic adsb.lol point response: fake addresses and identifiers only, no real aircraft.
const FIXTURE_TEXT = readFileSync(
  new URL("../fixtures/flights/point-synthetic.json", import.meta.url),
  "utf8",
);
const FIXTURE = JSON.parse(FIXTURE_TEXT) as { now: number; ac: Record<string, unknown>[] };
const T0 = FIXTURE.now;
const MINUTE = 60_000;
const KEPT = ["fake01", "fake02", "fake03"];
const OPTED_OUT = ["fake0a", "fake0b", "fake0c"];
const ALLOWED_KEYS = [
  "aircraft",
  "altFt",
  "category",
  "groundSpeedKt",
  "lat",
  "lon",
  "onGround",
  "positionAgeS",
  "t",
  "trackDeg",
];
const ALL_AREAS: FlightArea[] = [
  ...config.sources.flights.layerAreas,
  config.sources.flights.detectorArea,
];

async function freshDb(): Promise<Db> {
  const db = await openDb(":memory:");
  await migrate(db);
  return db;
}

/** A fixed fake salt, as the committed fixtures use. */
const fakeSalt = (size: number) => new Uint8Array(size).fill(7);

class FakeClock implements Clock {
  t: number;
  sleeps: number[] = [];
  constructor(start: number) {
    this.t = start;
  }
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.sleeps.push(ms);
    this.t += ms;
  }
}

interface FakeCall {
  url: string;
  at: number;
  userAgent: string | null;
}

/** A fake fetch on the fake clock that records every request and how many overlap. */
function fakeNetwork(clock: FakeClock, respond: () => Response, latencyMs = 0) {
  const calls: FakeCall[] = [];
  const state = { inFlight: 0, maxInFlight: 0 };
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      at: clock.t,
      userAgent: new Headers(init?.headers).get("user-agent"),
    });
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    clock.t += latencyMs;
    state.inFlight -= 1;
    return respond();
  }) as FetchImpl;
  return { impl, calls, state };
}

function fixtureResponse(): Response {
  return new Response(FIXTURE_TEXT, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function pointUrl(a: FlightArea): string {
  return `${config.sources.flights.baseUrl}/${a.lat}/${a.lon}/${a.radiusNm}`;
}

/** Every value in every table, with gzipped blobs decoded. */
async function dumpDatabase(db: Db): Promise<string> {
  const tables = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
  const parts: string[] = [];
  for (const table of tables.rows) {
    const rs = await db.execute(`SELECT * FROM "${String(table.name)}"`);
    for (const row of rs.rows) {
      for (const column of rs.columns) {
        const v = row[column];
        // libSQL returns BLOB columns as ArrayBuffer; every blob in this schema is gzipped.
        if (v instanceof ArrayBuffer) parts.push(gunzipText(new Uint8Array(v)));
        else parts.push(`${column}=${String(v)}`);
      }
    }
  }
  return parts.join("\n");
}

function sampleOf(samples: FlightSample[], t: number): FlightSample {
  const s = samples.find((x) => x.t === t);
  if (!s) throw new Error(`no sample at ${t}`);
  return s;
}

test("stored flight frames hold no identifiers and no LADD or PIA aircraft", async () => {
  const db = await freshDb();
  const clock = new FakeClock(T0);
  const net = fakeNetwork(clock, fixtureResponse);
  const identity = createAircraftIdentity({ randomBytes: fakeSalt });
  const provider = createAdsbLolProvider({ db, fetchImpl: net.impl, clock });

  const result = await runFlightsLayer(db, {
    now: T0,
    provider,
    idFor: (hex, t) => identity.aircraftId(hex, t),
  });
  expect(result).toEqual({ source: "flights", fetched: 21, inserted: 3, status: "ok" });
  expect(net.calls.map((c) => c.url)).toEqual(config.sources.flights.layerAreas.map(pointUrl));

  const frames = await listEvents(db, { kinds: ["flight_frame"], order: "asc" });
  expect(frames.map((f) => f.id).sort()).toEqual(
    config.sources.flights.layerAreas.map((a) => `flights:frame:${a.id}@${T0}`).sort(),
  );
  const keptIds = [
    identity.aircraftId("fake01", T0 - 400),
    identity.aircraftId("fake02", T0 - 1200),
    identity.aircraftId("fake03", T0 - 5000),
  ].sort();
  for (const frame of frames) {
    expect(frame.facts.aircraft?.text).toBe("3");
    expect(frame.raw).toBeNull();
    const json = gunzipText(frame.rawGz ?? new Uint8Array());
    expect(frame.rawDigest).toBe(sha256Hex(json));
    const stored = JSON.parse(json) as Record<string, unknown>[];
    expect(stored.map((s) => s.aircraft).sort()).toEqual(keptIds);
    for (const s of stored) expect(Object.keys(s).sort()).toEqual(ALLOWED_KEYS);
  }

  // Nothing identifying survives anywhere in the database: ids, facts, meta, raw_gz, logs.
  const dump = await dumpDatabase(db);
  // The dump really contains the decoded samples, so the scan below covers raw_gz.
  expect(dump).toContain(`"aircraft":"${keptIds[0]}"`);
  const forbidden = new Set<string>(["FAKE", "fake0", "adsb_icao", "mode_s", "squawk", "ownOp"]);
  for (const ac of FIXTURE.ac) {
    for (const key of ["hex", "flight", "r", "t", "desc", "ownOp", "squawk"]) {
      const v = ac[key];
      if (typeof v === "string") {
        forbidden.add(v);
        forbidden.add(v.trim());
      }
    }
  }
  for (const hex of OPTED_OUT) {
    const ac = FIXTURE.ac.find((a) => a.hex === hex);
    forbidden.add(String(ac?.lat));
    forbidden.add(String(ac?.lon));
    forbidden.add(identity.aircraftId(hex, T0 - Number(ac?.seen_pos) * 1000));
  }
  for (const s of forbidden) expect(dump, `leaked ${s}`).not.toContain(s);
});

test("redaction keeps only the allow-listed fields and never hashes an opted-out address", () => {
  const identity = createAircraftIdentity({ randomBytes: fakeSalt });
  const hashed: string[] = [];
  const idFor = (hex: string, t: number) => {
    hashed.push(hex);
    return identity.aircraftId(hex, t);
  };
  const [a1, a2, a3, ladd, pia, both, noPos] = FIXTURE.ac;
  expect(redactAircraft(a1, T0, idFor)).toEqual({
    aircraft: identity.aircraftId("fake01", T0 - 400),
    t: T0 - 400,
    lat: 51.5012,
    lon: -0.3021,
    altFt: 12000,
    groundSpeedKt: 250.5,
    trackDeg: 90.1,
    onGround: false,
    positionAgeS: 0.4,
    category: "A3",
  });
  expect(redactAircraft(a2, T0, idFor)).toMatchObject({
    altFt: null,
    onGround: true,
    groundSpeedKt: 3.2,
  });
  expect(redactAircraft(a3, T0, idFor)).toMatchObject({
    t: T0 - 5000,
    altFt: 3500,
    groundSpeedKt: null,
    trackDeg: null,
  });
  for (const dropped of [ladd, pia, both, noPos, null, "fake01", [a1], { ...a1, hex: "" }]) {
    expect(redactAircraft(dropped, T0, idFor)).toBeNull();
  }
  hashed.length = 0;
  expect(redactAll(FIXTURE.ac, T0, idFor)).toHaveLength(3);
  expect(hashed).toEqual(KEPT);
});

test("the adsb.lol queue never overlaps requests and keeps the minimum spacing", async () => {
  const db = await freshDb();
  const clock = new FakeClock(T0);
  const net = fakeNetwork(clock, fixtureResponse, 2_000);
  // A spacing below the configured floor is ignored.
  const provider = createAdsbLolProvider({ db, fetchImpl: net.impl, clock, minSpacingMs: 1_000 });
  const spacing = config.cadence.flightsMinSpacingSeconds * 1000;

  const results = await Promise.all(ALL_AREAS.map((a) => provider.fetchArea(a, T0)));
  expect(results.every((r) => r.ok)).toBe(true);
  expect(net.state.maxInFlight).toBe(1);
  expect(net.calls.map((c) => c.url)).toEqual(ALL_AREAS.map(pointUrl));
  expect(net.calls.map((c) => c.userAgent)).toEqual(ALL_AREAS.map(() => config.userAgent));
  const starts = net.calls.map((c) => c.at);
  expect(starts[0]).toBe(T0);
  for (let i = 1; i < starts.length; i++) {
    expect((starts[i] ?? 0) - (starts[i - 1] ?? 0)).toBe(spacing);
  }
  // Each request took 2 s, so the queue waited the rest of the spacing.
  expect(clock.sleeps).toEqual([spacing - 2_000, spacing - 2_000, spacing - 2_000]);
  const first = results[0];
  expect(first?.ok && first.now).toBe(T0);
  expect(first?.ok && first.requestedAt).toBe(T0);

  // After a long idle gap there is nothing to wait for.
  clock.t += 10 * MINUTE;
  await provider.fetchArea(config.sources.flights.detectorArea, clock.t);
  expect(clock.sleeps).toHaveLength(3);

  // A bad area rejects without stalling the queue.
  await expect(
    provider.fetchArea({ id: "bad", lat: 91, lon: 0, radiusNm: 10 }, clock.t),
  ).rejects.toThrow(RangeError);
  expect((await provider.fetchArea(config.sources.flights.detectorArea, clock.t)).ok).toBe(true);
  expect(net.calls).toHaveLength(6);
});

test("any 4xx stops the source and persists a backoff that later polls respect", async () => {
  const db = await freshDb();
  const clock = new FakeClock(T0);
  let status = 429;
  const net = fakeNetwork(clock, () =>
    status === 200 ? fixtureResponse() : new Response("stop", { status }),
  );
  const provider = createAdsbLolProvider({ db, fetchImpl: net.impl, clock });
  const deps = () => ({ now: clock.t, provider });

  const first = await runFlightsLayer(db, deps());
  expect(first).toMatchObject({ source: "flights", status: "error", fetched: 0, inserted: 0 });
  expect(first.message).toContain("HTTP 429");
  expect(net.calls).toHaveLength(1);
  expect(await getBackoff(db, "flights")).toEqual({
    failures: 1,
    nextAllowedAt: T0 + 15 * MINUTE,
    lastStatus: 429,
  });

  // While the backoff holds, neither poll sends a request.
  clock.t += 14 * MINUTE;
  expect(await runFlightsLayer(db, deps())).toMatchObject({ status: "skipped_backoff" });
  expect(await runFlightsDetectorSample(db, deps())).toMatchObject({
    status: "skipped_backoff",
    samples: [],
  });
  expect(net.calls).toHaveLength(1);

  // A second 4xx doubles the pause.
  clock.t = T0 + 15 * MINUTE;
  status = 403;
  expect(await runFlightsDetectorSample(db, deps())).toMatchObject({ status: "error" });
  expect(await getBackoff(db, "flights")).toEqual({
    failures: 2,
    nextAllowedAt: T0 + 45 * MINUTE,
    lastStatus: 403,
  });

  // After the pause a good response clears the backoff and all three areas are stored.
  clock.t = T0 + 45 * MINUTE;
  status = 200;
  expect(await runFlightsLayer(db, deps())).toMatchObject({ status: "ok", inserted: 3 });
  expect(await getBackoff(db, "flights")).toBeNull();
  expect(net.calls).toHaveLength(5);
  const errors = await db.execute("SELECT status FROM fetch_errors ORDER BY id");
  expect(errors.rows.map((r) => r.status)).toEqual([429, 403]);
});

test("5xx, network errors, and unreadable bodies back off from 5 minutes", async () => {
  const db = await freshDb();
  const clock = new FakeClock(T0);
  let mode: "503" | "throw" | "garbage" = "503";
  const impl = (async () => {
    if (mode === "throw") throw new TypeError("fetch failed");
    return mode === "503"
      ? new Response("busy", { status: 503 })
      : new Response("not json", { status: 200 });
  }) as FetchImpl;
  const provider = createAdsbLolProvider({ db, fetchImpl: impl, clock });
  const area = config.sources.flights.detectorArea;

  expect(await provider.fetchArea(area, clock.t)).toMatchObject({ ok: false, status: 503 });
  expect((await getBackoff(db, "flights"))?.nextAllowedAt).toBe(T0 + 5 * MINUTE);

  clock.t = T0 + 5 * MINUTE;
  mode = "throw";
  expect(await provider.fetchArea(area, clock.t)).toMatchObject({ ok: false, status: null });
  expect(await getBackoff(db, "flights")).toEqual({
    failures: 2,
    nextAllowedAt: clock.t + 10 * MINUTE,
    lastStatus: null,
  });

  clock.t += 10 * MINUTE;
  mode = "garbage";
  expect(await provider.fetchArea(area, clock.t)).toMatchObject({ ok: false, status: 200 });
  expect((await getBackoff(db, "flights"))?.nextAllowedAt).toBe(clock.t + 20 * MINUTE);
});

test("only the point endpoint can ever be requested", () => {
  const base = config.sources.flights.baseUrl;
  expect(adsbLolPointUrl({ id: "live", lat: 51.47, lon: -0.45, radiusNm: 25 })).toBe(
    `${base}/51.47/-0.45/25`,
  );
  for (const bad of [
    { lat: 91, lon: 0, radiusNm: 10 },
    { lat: 0, lon: Number.NaN, radiusNm: 10 },
    { lat: 0, lon: 0, radiusNm: 0 },
    { lat: 0, lon: 0, radiusNm: 251 },
  ]) {
    expect(() => adsbLolPointUrl({ id: "bad", ...bad })).toThrow(RangeError);
  }
  const origin = new URL(base).origin;
  for (const path of ["reg/FAKE-REG1", "hex/fake01", "callsign/FAKECS1", "ladd", "pia"]) {
    expect(() => assertPointEndpoint(`${origin}/v2/${path}`)).toThrow();
  }
  expect(() => assertPointEndpoint(`${base}/51.47/-0.45/25?extra=1`)).toThrow();
  expect(() => assertPointEndpoint(`${base}/51.47/-0.45`)).toThrow();
  expect(() => assertPointEndpoint(`https://example.com/v2/point/51.47/-0.45/25`)).toThrow();

  // No module file spells out an adsb.lol path of its own; the base URL comes from config.
  const dir = fileURLToPath(new URL("../../src/ingest/sources/flights/", import.meta.url));
  for (const file of readdirSync(dir)) {
    expect(readFileSync(join(dir, file), "utf8"), file).not.toMatch(/\/v2\//);
  }
});

test("the daily salt keeps an aircraft's id until 01:00 UTC, then drops the old salt", () => {
  const sizes: number[] = [];
  const identity = createAircraftIdentity({
    randomBytes: (size) => {
      sizes.push(size);
      return new Uint8Array(size).fill(sizes.length);
    },
  });
  const midnight = Date.UTC(2026, 8, 22);

  const before = identity.aircraftId("fake01", midnight - 2 * MINUTE);
  expect(before).toMatch(/^[0-9a-f]{16}$/);
  expect(identity.aircraftId(" FAKE01 ", midnight - MINUTE)).toBe(before);

  // An orbit in progress across midnight keeps its id through the first hour.
  expect(identity.aircraftId("fake01", midnight + 30 * MINUTE)).toBe(before);
  expect(identity.aircraftId("fake01", midnight + 59 * MINUTE)).toBe(before);
  // An aircraft first seen after midnight takes the new day's salt at once.
  const fresh = identity.aircraftId("fake02", midnight + 30 * MINUTE);

  // From 01:00 UTC the previous salt is gone and the old id cannot come back.
  const after = identity.aircraftId("fake01", midnight + 60 * MINUTE);
  expect(after).not.toBe(before);
  expect(identity.aircraftId("fake01", midnight + 90 * MINUTE)).toBe(after);
  expect(identity.aircraftId("fake02", midnight + 90 * MINUTE)).toBe(fresh);
  expect(identity.aircraftId("fake01", midnight - MINUTE)).toBe(after);
  expect(sizes).toEqual([32, 32]);

  // The salt is not reachable from the outside, and each process draws its own.
  expect(Object.keys(identity)).toEqual(["aircraftId"]);
  const a = createAircraftIdentity().aircraftId("fake01", midnight);
  const b = createAircraftIdentity().aircraftId("fake01", midnight);
  expect(a).not.toBe(b);
  expect(aircraftId("fake01", midnight)).toMatch(/^[0-9a-f]{16}$/);
});

test("frames, detector batches, and tracks carry counted facts and a digest of stored JSON", async () => {
  const identity = createAircraftIdentity({ randomBytes: fakeSalt });
  const samples = redactAll(FIXTURE.ac, T0, (hex, t) => identity.aircraftId(hex, t));

  const frame = buildLayerFrame("london", samples, T0, "fetch_log:flights:1789999200000");
  expect(frame).toMatchObject({
    id: `flights:frame:london@${T0}`,
    recordKey: "flights:frame:london",
    source: "flights",
    kind: "flight_frame",
    occurredAt: T0,
    fetchedAt: T0,
    lat: 51.47,
    lon: -0.45,
    title: "Flights around London",
    raw: null,
    fetchId: "fetch_log:flights:1789999200000",
  });
  expect(frame.facts).toEqual({
    aircraft: { value: 3, text: "3" },
    area: { value: "London", text: "London" },
    time: { value: T0, text: "14:13 UTC" },
  });
  expect(frame.meta).toEqual({ areaId: "london", provider: "adsb.lol", redaction: "v2" });
  const json = gunzipText(frame.rawGz ?? new Uint8Array());
  expect(frame.rawDigest).toBe(sha256Hex(json));
  expect(JSON.parse(json)).toHaveLength(3);
  // Extra fields on a sample never reach storage.
  const leaky = samples.map((s) => ({ ...s, hex: "fake01", r: "FAKE-REG1" }));
  expect(buildLayerFrame("london", leaky, T0, null).rawDigest).toBe(frame.rawDigest);
  expect(() => buildLayerFrame("atlantis", samples, T0, null)).toThrow();

  const later = samples.map((s) => ({ ...s, t: s.t + 30_000 }));
  const windowStart = T0 - 5 * MINUTE;
  const windowEnd = T0 + 30_000;
  const batch = buildDetectorBatch(
    "london-detector",
    [...samples, ...samples, ...later],
    windowStart,
    windowEnd,
    T0 + 31_000,
  );
  expect(batch.id).toBe(`flights:frame:london-detector@${windowEnd}`);
  expect(batch.kind).toBe("flight_frame");
  expect(batch.facts).toEqual({
    aircraft: { value: 3, text: "3" },
    samples: { value: 6, text: "6" },
    area: { value: "London", text: "London" },
    start: utcTime(windowStart),
    end: utcTime(windowEnd),
  });
  expect(batch.rawDigest).toBe(sha256Hex(gunzipText(batch.rawGz ?? new Uint8Array())));

  const one = sampleOf(samples, T0 - 400);
  const orbit: FlightSample[] = [0, 1, 2, 3].map((i) => ({
    ...one,
    t: one.t + i * 30_000,
    trackDeg: (90 + i * 90) % 360,
    altFt: i === 2 ? null : 12000 - i * 100,
  }));
  const others = samples.filter((s) => s.aircraft !== one.aircraft);
  const track = buildAircraftTrack(one.aircraft, [...orbit.reverse(), ...others], T0 + 2 * MINUTE);
  expect(track).toMatchObject({
    id: `flights:track:${opaqueKey(one.aircraft, one.t)}@${one.t + 90_000}`,
    recordKey: `flights:track:${opaqueKey(one.aircraft, one.t)}`,
    kind: "aircraft_track",
    occurredAt: one.t,
    sourceUpdatedAt: one.t + 90_000,
    rawGz: null,
  });
  expect(track.facts).toEqual({
    samples: { value: 4, text: "4" },
    start: utcTime(one.t),
    end: utcTime(one.t + 90_000),
    min_altitude: { value: 11700, text: "11700", unit: "ft" },
    max_altitude: { value: 12000, text: "12000", unit: "ft" },
  });
  expect(track.rawDigest).toBe(sha256Hex(track.raw ?? ""));
  const trackSamples = JSON.parse(track.raw ?? "[]") as Record<string, unknown>[];
  expect(trackSamples.map((s) => s.t)).toEqual([0, 1, 2, 3].map((i) => one.t + i * 30_000));
  // A track is one aircraft, so neither its id nor its samples carry the aircraft id.
  for (const s of trackSamples) expect(s).not.toHaveProperty("aircraft");
  expect(JSON.stringify(track)).not.toContain(one.aircraft);
  const ground = sampleOf(samples, T0 - 1200);
  const groundTrack = buildAircraftTrack(ground.aircraft, [ground], T0);
  expect(groundTrack.facts.min_altitude).toBeUndefined();
  expect(() => buildAircraftTrack("0000000000000000", samples, T0)).toThrow();

  for (const e of [frame, batch, track]) {
    expect(e.title).not.toMatch(/[\u2013\u2014]/);
    expect(e.title.charAt(0)).toBe(e.title.charAt(0).toUpperCase());
  }

  // All three go through the write guard and read back unchanged.
  const db = await freshDb();
  expect(await insertEvents(db, [frame, batch, track], "ingest", T0)).toBe(3);
  const [storedFrame] = await getEvents(db, [frame.id]);
  expect(gunzipText(storedFrame?.rawGz ?? new Uint8Array())).toBe(json);
});

test("a detector poll returns redacted samples and stores nothing", async () => {
  const db = await freshDb();
  const seen: FlightArea[] = [];
  const provider: FlightProvider = {
    name: "fake",
    async fetchArea(area, now) {
      seen.push(area);
      return { ok: true, now, aircraft: FIXTURE.ac };
    },
  };
  const identity = createAircraftIdentity({ randomBytes: fakeSalt });
  const res = await runFlightsDetectorSample(db, {
    now: T0,
    provider,
    idFor: (hex, t) => identity.aircraftId(hex, t),
  });
  expect(res).toMatchObject({ source: "flights", status: "ok", fetched: 7, inserted: 0 });
  expect(res.samples.map((s) => s.aircraft)).toEqual([
    identity.aircraftId("fake01", T0 - 400),
    identity.aircraftId("fake02", T0 - 1200),
    identity.aircraftId("fake03", T0 - 5000),
  ]);
  expect(seen).toEqual([config.sources.flights.detectorArea]);
  expect(await listEvents(db, { kinds: ["flight_frame", "aircraft_track"] })).toHaveLength(0);
});
