import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { config } from "../../argus.config.ts";
import {
  AIRCRAFT_REMOVED_NOTE,
  buildEventsPayload,
  RECORD_MAX_CHARS,
  trimRecord,
  withoutAircraft,
} from "../../src/api/server/citations.ts";
import { parseIds } from "../../src/api/server/params.ts";
import { ARGUS_CREDIT } from "../../src/api/server/store.ts";
import { buildAggregate } from "../../src/ask/tools.ts";
import { getLinks, insertEvents, latestVersion } from "../../src/db/queries.ts";
import type { FlightSample } from "../../src/detectors/types.ts";
import { materializeCellDay, parseFirmsCsv } from "../../src/ingest/sources/firms.ts";
import { buildAircraftTrack, buildLayerFrame } from "../../src/ingest/sources/flights/frames.ts";
import { redactAll } from "../../src/ingest/sources/flights/redact.ts";
import { createAircraftIdentity } from "../../src/ingest/sources/flights/salt.ts";
import { gunzipText } from "../../src/lib/gzip.ts";
import { localSolarDayKey } from "../../src/lib/time.ts";
import {
  FIRMS_FETCHED,
  FIRMS_SAMPLE,
  freshDb,
  HOUR,
  seedFirms,
  seedUsgs,
  storeClusters,
  storeFeed,
  SWARM_T,
  swarmFeed,
} from "../fixtures/read-api/seed.ts";

const credit = (layerId: string) => config.layers.find((l) => l.id === layerId)?.credit;

test("quakes, detections, cell days, and missing ids, in request order", async () => {
  const db = await freshDb();
  await seedUsgs(db);
  await storeFeed(db, swarmFeed(), SWARM_T + 3 * HOUR);
  const [cluster] = await storeClusters(db);
  if (!cluster) throw new Error("the swarm made no cluster");
  await seedFirms(db);
  const day = localSolarDayKey(Date.UTC(2026, 8, 22, 20, 0), -118.5);
  const cellDay = await materializeCellDay(db, "34,-119", day, FIRMS_FETCHED, new Set());
  const quake = await latestVersion(db, "usgs:us6000tx3m");
  if (!quake) throw new Error("seed is missing us6000tx3m");

  // The fire cell id spells the cell with "_", so a comma-separated list splits cleanly.
  expect(cellDay.id).toContain("34_-119");
  expect(cellDay.id).not.toContain(",");
  const parsed = parseIds(
    new URLSearchParams({
      ids: [cluster.id, "usgs:nothere@1", cellDay.id, quake.id, cluster.id].join(","),
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error);
  expect(parsed.value).toEqual([cluster.id, "usgs:nothere@1", cellDay.id, quake.id]);

  const payload = await buildEventsPayload(db, { ids: parsed.value });
  expect(payload.missing).toEqual(["usgs:nothere@1"]);
  expect(payload.events.map((e) => e.id)).toEqual([cluster.id, cellDay.id, quake.id]);
  const [c, cell, q] = payload.events;

  expect(c).toMatchObject({
    source: "argus",
    kind: "detection",
    title: cluster.title,
    credit: ARGUS_CREDIT,
    record: cluster.raw,
    recordNote: null,
    facts: cluster.facts,
    rawDigest: cluster.rawDigest,
  });
  expect(c?.members).toEqual(await getLinks(db, cluster.id));
  expect(c?.members).toHaveLength(4);
  const box = cluster.bbox;
  if (!box) throw new Error("a cluster has a bbox");
  expect(c?.bbox).toEqual([box.minLon, box.minLat, box.maxLon, box.maxLat]);

  expect(cell).toMatchObject({
    source: "firms",
    kind: "fire_cell_day",
    credit: credit("fires"),
    record: cellDay.raw,
    members: [],
  });
  expect(cell?.facts.cell?.text).toBe("34,-119");

  expect(q).toEqual({
    id: quake.id,
    source: "usgs",
    kind: "earthquake",
    title: quake.title,
    occurredAt: quake.occurredAt,
    fetchedAt: quake.fetchedAt,
    lat: quake.lat,
    lon: quake.lon,
    bbox: null,
    facts: quake.facts,
    record: quake.raw,
    recordNote: null,
    rawDigest: quake.rawDigest,
    supersedes: quake.supersedes,
    members: [],
    credit: "Earthquake data courtesy of the U.S. Geological Survey",
  });
});

test("a bulk record is decoded and trimmed to 8000 characters with a note", async () => {
  const db = await freshDb();
  // 200 copies of the sample's 2026-09-22 lines, each with its own acquisition minute.
  const [header, ...lines] = FIRMS_SAMPLE.trimEnd().split("\n");
  const sep22 = lines.filter((l) => l.includes(",2026-09-22,"));
  const big = [header];
  for (let i = 0; i < 200; i++) {
    const line = sep22[i % sep22.length] ?? "";
    const minute = String(i % 60).padStart(2, "0");
    big.push(line.replace(/,2026-09-22,\d{4},/, `,2026-09-22,12${minute},`));
  }
  const csv = `${big.join("\n")}\n`;
  expect(parseFirmsCsv(csv)).toHaveLength(200);
  const [batch] = await seedFirms(db, csv, "citations-big");
  if (!batch?.rawGz) throw new Error("the batch has no gzipped body");
  const stored = gunzipText(batch.rawGz);
  expect(stored.length).toBeGreaterThan(RECORD_MAX_CHARS);

  const { events } = await buildEventsPayload(db, { ids: [batch.id] });
  const e = events[0];
  expect(e?.record).toBe(stored.slice(0, RECORD_MAX_CHARS));
  expect(e?.recordNote).toBe(
    `The stored record is ${stored.length} characters long. The first ${RECORD_MAX_CHARS} are shown and ${
      stored.length - RECORD_MAX_CHARS
    } are left out.`,
  );
  expect(e?.credit).toBe(credit("fires"));
  expect(e?.rawDigest).toBe(batch.rawDigest);
});

test("flight records are shown without aircraft digests", async () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/flights/point-synthetic.json", import.meta.url), "utf8"),
  ) as { now: number; ac: Record<string, unknown>[] };
  const identity = createAircraftIdentity({ randomBytes: (size) => new Uint8Array(size).fill(7) });
  const T = fixture.now;
  const samples = redactAll(fixture.ac, T, (hex, t) => identity.aircraftId(hex, t));
  const first = samples[0];
  if (!first) throw new Error("the fixture has no aircraft");
  const turn: FlightSample[] = [0, 1, 2, 3].map((i) => ({
    ...first,
    t: first.t + i * 30_000,
    trackDeg: (i * 90) % 360,
  }));
  const frame = buildLayerFrame("london", samples, T, null);
  const track = buildAircraftTrack(first.aircraft, turn, T + 2 * 60_000);

  const db = await freshDb();
  await insertEvents(db, [frame, track], "ingest", T);
  const { events } = await buildEventsPayload(db, { ids: [frame.id, track.id] });
  expect(events).toHaveLength(2);
  const digests = samples.map((s) => s.aircraft);
  for (const e of events) {
    expect(e.recordNote).toBe(AIRCRAFT_REMOVED_NOTE);
    expect(e.credit).toBe(credit("flights"));
    expect(e.record).not.toContain('"aircraft"');
    for (const d of digests) expect(e.record).not.toContain(d);
  }
  // Every other stored field survives, and the track still parses for the globe.
  const shownFrame = JSON.parse(events[0]?.record ?? "[]") as Array<Record<string, unknown>>;
  const storedFrame = JSON.parse(gunzipText(frame.rawGz ?? new Uint8Array())) as Array<
    Record<string, unknown>
  >;
  expect(shownFrame).toEqual(
    storedFrame.map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== "aircraft"))),
  );
  const shownTrack = JSON.parse(events[1]?.record ?? "[]") as Array<{ lon: number; lat: number }>;
  expect(shownTrack.map((s) => [s.lon, s.lat])).toEqual(turn.map((s) => [s.lon, s.lat]));
});

test("record helpers", () => {
  // A surrogate pair at the cut is never split.
  const text = `${"a".repeat(RECORD_MAX_CHARS - 1)}\u{1F30D}tail`;
  const trimmed = trimRecord(text);
  expect(trimmed.text).toBe("a".repeat(RECORD_MAX_CHARS - 1));
  expect(trimmed.leftOut).toBe(text.length - (RECORD_MAX_CHARS - 1));
  expect(trimRecord("short")).toEqual({ text: "short", leftOut: 0 });

  expect(withoutAircraft('[{"aircraft":"0123456789abcdef","t":1,"lat":2}]')).toBe(
    '[{"t":1,"lat":2}]',
  );
  expect(withoutAircraft('{"area":"London","samples":[{"aircraft":"x","t":1}]}')).toBe(
    '{"area":"London","samples":[{"t":1}]}',
  );
  expect(withoutAircraft("not json")).toBeNull();
});

test("an aggregate's members come from its facts, since aggregates have no link rows", async () => {
  const db = await freshDb();
  const members = ["usgs:b@1", "usgs:a@1", "firms:cell:34_-119:20718@abc"];
  const aggregate = buildAggregate(
    { kinds: ["earthquake"], bbox: null, from: SWARM_T - HOUR, to: SWARM_T, minMagnitude: null },
    members,
    SWARM_T,
  );
  await insertEvents(db, [aggregate], "ask", SWARM_T);
  expect(await getLinks(db, aggregate.id)).toEqual([]);
  const payload = await buildEventsPayload(db, { ids: [aggregate.id] });
  expect(payload.events[0]?.members).toEqual([...members].sort());
});
