import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { migrate, openDb } from "../../src/db/client.ts";
import { getEvents, insertEvents } from "../../src/db/queries.ts";
import { computed, count, label, upstream, utcDate, utcTime } from "../../src/events/facts.ts";
import type { EventRecord, Facts } from "../../src/events/types.ts";
import { checkSentences, type CheckViolationKind } from "../../src/check/check-brief.ts";
import { BANNED_WORDS, copyViolations } from "../../src/check/copy-rules.ts";
import { citableTokens, extractTokens } from "../../src/check/tokens.ts";
import { sha256Hex } from "../../src/lib/digest.ts";
import { recordKeyOf, versionId } from "../../src/lib/ids.ts";

interface GoldenCase {
  text: string;
  facts_texts: string[];
  expect_ok: boolean;
  expect_kinds?: string[];
}

const golden = JSON.parse(
  readFileSync(new URL("../fixtures/check/golden.json", import.meta.url), "utf8"),
) as { cases: GoldenCase[] };

function kindsOf(result: { violations: { kind: string }[] }): string[] {
  return [...new Set(result.violations.map((v) => v.kind))].sort();
}

// 2026-09-23T21:46:40Z, a fixed clock for every record below.
const T0 = 1_790_200_000_000;

function record(
  source: EventRecord["source"],
  nativeId: string,
  version: string | number,
  kind: EventRecord["kind"],
  facts: Facts,
  raw: string,
  meta: EventRecord["meta"] = null,
): EventRecord {
  return {
    id: versionId(source, nativeId, version),
    recordKey: recordKeyOf(source, nativeId),
    source,
    kind,
    occurredAt: T0,
    fetchedAt: T0 + 60_000,
    sourceUpdatedAt: null,
    lat: 35.77,
    lon: -117.6,
    bbox: null,
    title: "Test record",
    facts,
    meta,
    raw,
    rawGz: null,
    rawDigest: sha256Hex(raw),
    fetchId: null,
    supersedes: null,
  };
}

// A USGS quake as the adapter stores it. The raw feature carries numbers (sig, nst) that are not
// facts, so a sentence may never use them.
const quakeRaw = JSON.stringify({
  type: "Feature",
  id: "ci41234567",
  properties: {
    mag: 4.63,
    place: "10 km NNE of Ridgecrest, CA",
    time: T0,
    updated: T0,
    sig: 312,
    nst: 42,
    type: "earthquake",
  },
  geometry: { type: "Point", coordinates: [-117.6, 35.77, -1.2] },
});
const quake = record(
  "usgs",
  "ci41234567",
  T0,
  "earthquake",
  {
    mag: upstream(4.63),
    depth_km: upstream(-1.2, "km"),
    place: label("10 km NNE of Ridgecrest, CA"),
    time: utcTime(T0),
    date: utcDate(T0),
    code: label("ci41234567"),
  },
  quakeRaw,
);

// A quake-cluster detection: measured facts are citable, thresholds live in meta and are not.
const cluster = record(
  "argus",
  "quake-cluster:3f9a0c1d2e4b",
  1,
  "detection",
  {
    count: count(7),
    max_distance_km: computed(18.34, 1, "km"),
    span_hours: computed(2.46, 1, "h"),
    max_mag: upstream(4.63),
    first_time: utcTime(T0),
    last_time: utcTime(T0 + 8_400_000),
  },
  JSON.stringify({ members: 7 }),
  { thresholds: { minCount: 4, radiusKm: 25, windowHours: 6 } },
);

// A fire-growth detection on NOAA-20 data.
const fire = record(
  "argus",
  "fire-growth:38,-120:20720",
  1,
  "detection",
  {
    cell: label("38,-120"),
    count_day0: count(118),
    count_day1: count(241),
    growth_pct: count(104, "%"),
    date_day1: label("2026-09-22"),
    satellite: label("NOAA-20"),
  },
  JSON.stringify({ cell: "38,-120" }),
);

const events = new Map([quake, cluster, fire].map((e) => [e.id, e]));

test.describe("golden file", () => {
  test("has at least 40 cases and every kind a sentence text can trigger", () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(40);
    const kinds = new Set(golden.cases.flatMap((c) => c.expect_kinds ?? []));
    const textKinds: CheckViolationKind[] = [
      "number_not_in_facts",
      "alnum_not_in_facts",
      "number_word",
      "non_ascii_digit",
      "dash",
      "banned_word",
      "id_in_text",
      "not_capitalized",
    ];
    for (const kind of textKinds) expect(kinds, kind).toContain(kind);
    for (const c of golden.cases) {
      // A failing case must name its kinds, so the file pins the grammar, not just the verdict.
      if (c.expect_ok) expect(c.expect_kinds ?? [], c.text).toEqual([]);
      else expect(c.expect_kinds?.length ?? 0, c.text).toBeGreaterThan(0);
    }
  });

  golden.cases.forEach((c, i) => {
    test(`case ${String(i + 1).padStart(2, "0")}: ${c.text}`, () => {
      const facts: Facts = Object.fromEntries(c.facts_texts.map((t, j) => [`f${j}`, label(t)]));
      const e = record("argus", `golden:${i + 1}`, 1, "aggregate", facts, "{}");
      const result = checkSentences([{ text: c.text, event_ids: [e.id] }], new Map([[e.id, e]]));
      expect(result.ok, JSON.stringify(result.violations)).toBe(c.expect_ok);
      expect(kindsOf(result)).toEqual([...(c.expect_kinds ?? [])].sort());
    });
  });
});

test.describe("tokens", () => {
  const cases: [string, string[], string[]][] = [
    [
      "M4.6 at 21:55 UTC on 2026-09-22, depth -1.2 km, 12,345 hotspots, up 45%.",
      ["4.6", "21:55", "2026-09-22", "-1.2", "12345", "45"],
      [],
    ],
    ["M 4.6 and M-4.6 and m4.6", ["4.6"], ["m-4.6", "m4.6"]],
    ["NOAA-20, ci41234567, 25-km, 22nd", [], ["noaa-20", "ci41234567", "25-km", "22nd"]],
    ["3-5 km, 21:55-22:10, and 38,-120", ["3", "5", "21:55", "22:10", "38", "-120"], []],
    ["Odd forms: 1,23 and 1.2.3 and .5 and -.5", ["1,23", "1.2.3", ".5", "-.5"], []],
    ["Ends with 4.6. Next.7 more", ["4.6", "7"], []],
    ["Minus sign \u22121.2 and hyphen \u20105", ["-1.2", "-5"], []],
    ["Id usgs:ci41234567@1790200000000 has 7", ["7"], []],
    ["Fullwidth M\uFF14.\uFF16, superscript km\u00B2, Arabic \u0664", [], []],
  ];
  for (const [text, numbers, alnum] of cases) {
    test(`extractTokens: ${text}`, () => {
      expect(extractTokens(text)).toEqual({ numbers, alnum });
    });
  }

  test("citableTokens reads facts.*.text only, never raw or meta", () => {
    const tokens = citableTokens([quake, cluster]);
    expect([...tokens.numbers].sort()).toEqual(
      ["-1.2", "10", "18.3", "2.5", "2026-09-23", "21:46", "4.63", "7", "00:06"].sort(),
    );
    expect([...tokens.alnum]).toEqual(["ci41234567"]);
    for (const hidden of ["312", "42", "25", "4", "6"])
      expect(tokens.numbers).not.toContain(hidden);
  });
});

test.describe("copy rules", () => {
  test("the banned list is the brief's 10 words", () => {
    expect([...BANNED_WORDS]).toEqual([
      "leverage",
      "delve",
      "landscape",
      "showcase",
      "pivotal",
      "seamless",
      "robust",
      "empower",
      "unlock",
      "transform",
    ]);
  });

  test("banned words match whole words with their inflections, any case", () => {
    const hits = [
      "leverage",
      "Leverages",
      "leveraged",
      "LEVERAGING",
      "delve",
      "delves",
      "delved",
      "delving",
      "landscape",
      "landscapes",
      "showcase",
      "showcased",
      "showcasing",
      "pivotal",
      "seamless",
      "seamlessly",
      "robust",
      "robustly",
      "robustness",
      "empower",
      "empowerment",
      "unlock",
      "unlocked",
      "transform",
      "transformation",
      "transformer",
    ];
    for (const word of hits) {
      expect(copyViolations(`The ${word} test.`), word).toEqual([
        { kind: "banned_word", token: word, detail: `"${word}" is a banned word` },
      ]);
    }
    for (const word of [
      "lever",
      "delta",
      "landscaper",
      "pivot",
      "seam",
      "robusta",
      "power",
      "lock",
    ]) {
      expect(copyViolations(`The ${word} test.`), word).toEqual([]);
    }
  });

  test("dashes are reported per occurrence, including compatibility forms", () => {
    const found = copyViolations("A\u2014b \u2013 c\u2012d\u2015e\u2E3Af\u2E3Bg\uFE58h\uFE31i-j");
    expect(found.map((v) => v.token)).toEqual([
      "\u2014",
      "\u2013",
      "\u2012",
      "\u2015",
      "\u2E3A",
      "\u2E3B",
      "\u2014",
      "\u2014",
    ]);
    expect(found.every((v) => v.kind === "dash")).toBe(true);
    expect(found[0]?.detail).toBe("Em dash (U+2014) is not allowed");
    expect(copyViolations("Plain hyphen-minus - text.")).toEqual([]);
  });
});

test.describe("checkSentences with stored events", () => {
  test("a clean brief passes and counts every number it checks", () => {
    const result = checkSentences(
      [
        {
          text: "An M4.63 quake struck 10 km NNE of Ridgecrest, CA at 21:46 UTC.",
          event_ids: [quake.id],
        },
        {
          text: "A cluster of 7 quakes spanned 2.5 h, reaching 18.3 km from its anchor.",
          event_ids: [cluster.id],
        },
        {
          text: "Heat detections in cell 38,-120 rose 104% from 118 to 241 on NOAA-20.",
          event_ids: [fire.id],
        },
        {
          text: "The strongest quake, M4.63, sat at a depth of -1.2 km on 2026-09-23.",
          event_ids: [quake.id, cluster.id],
        },
      ],
      events,
    );
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    // (4.63, 10, 21:46) + (7, 2.5, 18.3) + (38, -120, 104, 118, 241, noaa-20) + (4.63, -1.2, 2026-09-23)
    expect(result.numbersChecked).toBe(3 + 3 + 6 + 3);
  });

  test("thresholds in meta and numbers only in raw are not citable", () => {
    const result = checkSentences(
      [
        { text: "The cluster held 7 quakes within 25 km.", event_ids: [cluster.id] },
        { text: "The quake had a significance of 312.", event_ids: [quake.id] },
      ],
      events,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      {
        kind: "number_not_in_facts",
        sentenceIndex: 0,
        token: "25",
        detail: "25 is not in the cited facts",
      },
      {
        kind: "number_not_in_facts",
        sentenceIndex: 1,
        token: "312",
        detail: "312 is not in the cited facts",
      },
    ]);
  });

  test("only the cited events count, and a rounded magnitude fails", () => {
    const result = checkSentences(
      [
        { text: "The cluster peaked at a depth of -1.2 km.", event_ids: [cluster.id] },
        { text: "The quake reached M4.6.", event_ids: [quake.id] },
      ],
      events,
    );
    expect(result.violations.map((v) => [v.sentenceIndex, v.kind, v.token])).toEqual([
      [0, "number_not_in_facts", "-1.2"],
      [1, "number_not_in_facts", "4.6"],
    ]);
  });

  test("missing and unresolved citations fail", () => {
    const result = checkSentences(
      [
        { text: "Quakes struck near Ridgecrest.", event_ids: [] },
        { text: "A cluster held 7 quakes.", event_ids: ["argus:quake-cluster:gone@1"] },
        { text: "A cluster held 7 quakes.", event_ids: [cluster.id, cluster.id] },
      ],
      events,
    );
    expect(result.violations.map((v) => [v.sentenceIndex, v.kind, v.token])).toEqual([
      [0, "no_citation", undefined],
      [1, "unresolved_id", "argus:quake-cluster:gone@1"],
      [1, "number_not_in_facts", "7"],
    ]);
    expect(result.numbersChecked).toBe(2);
  });

  test("a violation repeats once per sentence and kind and token", () => {
    const result = checkSentences(
      [{ text: "Three, three, and 9 and 9 quakes.", event_ids: [cluster.id] }],
      events,
    );
    expect(result.violations.map((v) => [v.kind, v.token])).toEqual([
      ["number_word", "Three"],
      ["number_word", "three"],
      ["number_not_in_facts", "9"],
    ]);
    expect(result.numbersChecked).toBe(2);
  });

  test("facts survive the store round trip and still check", async () => {
    const db = await openDb(":memory:");
    await migrate(db);
    expect(await insertEvents(db, [quake, cluster, fire], "ingest", T0)).toBe(3);
    const stored = await getEvents(db, [quake.id, cluster.id, fire.id]);
    const map = new Map(stored.map((e) => [e.id, e]));
    const pass = checkSentences(
      [{ text: "NOAA-20 counted 241 heat detections in cell 38,-120.", event_ids: [fire.id] }],
      map,
    );
    expect(pass.ok).toBe(true);
    const fail = checkSentences(
      [{ text: "NOAA-21 counted 241 heat detections in cell 38,-120.", event_ids: [fire.id] }],
      map,
    );
    expect(fail.violations.map((v) => [v.kind, v.token])).toEqual([
      ["alnum_not_in_facts", "noaa-21"],
    ]);
  });
});
