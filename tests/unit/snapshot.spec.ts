// DEMO template brief, the live USGS parser, and the snapshot resolver used by the static deploy.
import { expect, test } from "@playwright/test";
import { checkSentences } from "../../src/check/check-brief.ts";
import { count, label, upstream, utcDate, utcTime } from "../../src/events/facts.ts";
import type { EventRecord, Facts } from "../../src/events/types.ts";
import {
  TEMPLATE_QUESTIONS,
  templateAnswer,
  templateBullets,
  templateSentence,
} from "../../src/brief/template.ts";
import { parseUsgsFeed, usgsIdOf } from "../../src/snapshot/live-usgs.ts";

const T0 = 1_790_200_000_000;

function ev(id: string, kind: EventRecord["kind"], facts: Facts, meta: EventRecord["meta"] = null) {
  const e: EventRecord = {
    id,
    recordKey: id.split("@")[0]!,
    source: id.startsWith("argus:") ? "argus" : id.startsWith("eonet:") ? "eonet" : "usgs",
    kind,
    occurredAt: T0,
    fetchedAt: T0,
    sourceUpdatedAt: null,
    lat: 10,
    lon: 20,
    bbox: null,
    title: "t",
    facts,
    meta,
    raw: "{}",
    rawGz: null,
    rawDigest: "d",
    fetchId: null,
    supersedes: null,
  };
  return e;
}

const quake = (n: string, mag: string, place: string) =>
  ev(`usgs:${n}@1`, "earthquake", {
    mag: upstream(mag),
    place: label(place),
    time: utcTime(T0),
    date: utcDate(T0),
    depth_km: upstream("10.5", "km"),
    type: label("earthquake"),
  });

const cluster = ev(
  "argus:quake-cluster:abc",
  "detection",
  {
    count: count(7),
    max_distance_km: upstream("41.2", "km"),
    max_mag: upstream("4.4"),
    first_time: utcTime(T0 - 3_600_000),
    last_time: utcTime(T0),
    place: label("12 km E of Ridgecrest, CA"),
  },
  { detector: "quake-cluster" },
);

const circling = ev(
  "argus:circling:xyz",
  "detection",
  {
    total_turn_deg: count(735, "deg"),
    direction: label("left"),
    area: label("London"),
    start_time: utcTime(T0 - 600_000),
    end_time: utcTime(T0),
  },
  { detector: "circling" },
);

const storm = ev("eonet:EONET_1@a", "natural_event", {
  title: label("Tropical Storm Alpha 2026"),
  category: label("Severe Storms"),
  date: utcDate(T0),
});

const quakeCount = ev("argus:aggregate:abc", "aggregate", {
  count: count(5),
  kinds: label("earthquake"),
  min_magnitude: upstream("4.5"),
  from_date: utcDate(T0 - 86_400_000),
  from_time: utcTime(T0 - 86_400_000),
  to_date: utcDate(T0),
  to_time: utcTime(T0),
});

const all = [
  cluster,
  circling,
  quake("us1", "5.1", "19 km NNW of Masumbwe, Tanzania"),
  quake("us2", "4.96", "Sea of Okhotsk"),
  quake("us3", "4.5", "2 km W of Chinandega, Nicaragua"),
  storm,
  quakeCount,
];

test("template brief: 5 bullets, each passes the rule 4 checker against its cited event", () => {
  const bullets = templateBullets(all);
  expect(bullets).toHaveLength(5);
  const result = checkSentences(bullets, new Map(all.map((e) => [e.id, e])));
  expect(result.violations).toEqual([]);
  expect(result.numbersChecked).toBeGreaterThan(10);
  expect(bullets[0]!.text).toBe(
    "Argus found 7 quakes within 41.2 km of each other near 12 km E of Ridgecrest, CA, from 20:46 UTC to 21:46 UTC. The strongest was magnitude 4.4.",
  );
  expect(bullets[2]!.text).toBe(
    "Magnitude 5.1 quake, 19 km NNW of Masumbwe, Tanzania. It struck at 21:46 UTC on 2026-09-23, 10.5 km deep.",
  );
});

test("template brief: an event whose facts cannot fill a template is skipped", () => {
  const bare = ev("usgs:x@1", "earthquake", { place: label("Nowhere") });
  expect(templateSentence(bare)).toBeNull();
  expect(templateBullets([bare, storm])).toHaveLength(1);
});

test("template Ask: every preset answer passes the checker", () => {
  const byId = new Map(all.map((e) => [e.id, e]));
  for (const q of TEMPLATE_QUESTIONS) {
    const answer = templateAnswer(q, all);
    expect(answer.length, q.question).toBeGreaterThan(0);
    expect(checkSentences(answer, byId).violations, q.question).toEqual([]);
  }
  const strongest = templateAnswer(
    TEMPLATE_QUESTIONS.find((q) => q.question === "Which quakes were strongest?")!,
    all,
  );
  expect(strongest.map((s) => s.event_ids[0])).toEqual(["usgs:us1@1", "usgs:us2@1", "usgs:us3@1"]);
});

test("template count: the aggregate sentence copies its facts", () => {
  expect(templateSentence(quakeCount)).toBe(
    "USGS reported 5 quakes of magnitude 4.5 or more between 21:46 UTC on 2026-09-22 and 21:46 UTC on 2026-09-23.",
  );
});

test("live USGS: recorded ids and non-quakes are left out", () => {
  const body = {
    features: [
      {
        id: "us1",
        properties: { mag: 5, time: T0, place: "a", type: "earthquake" },
        geometry: { coordinates: [1, 2, 3] },
      },
      {
        id: "us9",
        properties: { mag: 2.2, time: T0, place: "b", type: "earthquake" },
        geometry: { coordinates: [4, 5, 6] },
      },
      {
        id: "us8",
        properties: { mag: 1, time: T0, place: "c", type: "quarry blast" },
        geometry: { coordinates: [4, 5, 6] },
      },
      { id: "us7", properties: {}, geometry: { coordinates: null } },
    ],
  };
  const live = parseUsgsFeed(body, new Set([usgsIdOf("usgs:us1@1793886802040")!]));
  expect(live.map((q) => q.id)).toEqual(["us9"]);
  expect(live[0]).toMatchObject({ lon: 4, lat: 5, mag: 2.2 });
  expect(parseUsgsFeed(null, new Set())).toEqual([]);
  expect(usgsIdOf("eonet:EONET_1@a")).toBeNull();
});
