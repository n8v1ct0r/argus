import { expect, test } from "@playwright/test";
import { config } from "../../argus.config.ts";
import { checkStoredBriefs } from "../../scripts/check-briefs.ts";
import { buildFactsPack } from "../../src/brief/facts.ts";
import { generateBrief, latestBriefPayload } from "../../src/brief/generate.ts";
import { BRIEF_SYSTEM_PROMPT, PROMPT_VERSION } from "../../src/brief/prompt.ts";
import { copyViolations } from "../../src/check/copy-rules.ts";
import { insertEvents } from "../../src/db/queries.ts";
import { FakeModelClient, textResult, type ModelRequest } from "../../src/model/client.ts";
import { freshDb, HOUR, MINUTE, quake, seedScene, T0 } from "../fixtures/model/events.ts";

function bulletsJson(texts: string[], ids: string[][]): string {
  return JSON.stringify({ bullets: texts.map((text, i) => ({ text, event_ids: ids[i] ?? [] })) });
}

test("the facts pack puts detections first, caps circling, and is deterministic", async () => {
  const db = await freshDb();
  const scene = await seedScene(db);
  const pack = await buildFactsPack(db, T0);

  const expected = [
    scene.cluster.id,
    scene.fireGrowth.id,
    // Newest circling episodes first, capped at maxCirclingInBrief.
    ...[...scene.circling]
      .reverse()
      .slice(0, config.detectors.circling.maxCirclingInBrief)
      .map((e) => e.id),
    // Largest quakes: the M5.4, then the cluster members by magnitude. The quarry blast (M6.1) and
    // the ended quake are left out.
    "usgs:us7000big",
  ];
  expect(pack.eventIds.slice(0, expected.length - 1)).toEqual(expected.slice(0, -1));
  expect(pack.eventIds[expected.length - 1]).toMatch(/^usgs:us7000big@/);
  expect(pack.items.map((i) => i.id)).toEqual(pack.items.map((_, i) => `E${i + 1}`));
  expect(pack.items[0]?.detector).toBe("earthquake cluster");
  expect(pack.items[1]?.detector).toBe("heat detection growth");
  expect(pack.items[2]?.detector).toBe("circling aircraft");
  expect(pack.eventIds.filter((id) => id.startsWith("argus:circling:"))).toHaveLength(
    config.detectors.circling.maxCirclingInBrief,
  );
  expect(pack.eventIds.some((id) => id.startsWith("usgs:ci8000qb"))).toBe(false);
  expect(pack.eventIds.some((id) => id.startsWith("usgs:nc7000gone"))).toBe(false);
  expect(pack.eventIds.some((id) => id.startsWith(scene.storm.recordKey))).toBe(true);
  expect(pack.eventIds.some((id) => id.startsWith(scene.wildfire.recordKey))).toBe(false);
  expect(pack.items.length).toBeLessThanOrEqual(config.brief.maxEventsInFactsPack);

  // Same data, inserted in the opposite order into another database: the same pack.
  const other = await freshDb();
  await seedScene(other, "reverse");
  const again = await buildFactsPack(other, T0);
  expect(again.digest).toBe(pack.digest);
  expect(again.items).toEqual(pack.items);
  expect((await buildFactsPack(db, T0)).digest).toBe(pack.digest);
  // A different window is different data.
  expect((await buildFactsPack(db, T0 + 20 * HOUR)).digest).not.toBe(pack.digest);
});

test("the facts pack carries no aircraft digests, version ids, titles, raw, or meta", async () => {
  const db = await freshDb();
  const scene = await seedScene(db);
  const pack = await buildFactsPack(db, T0);
  const modelFacing = JSON.stringify(pack.items);
  for (const a of scene.aircraft) expect(modelFacing).not.toContain(a);
  expect(modelFacing).not.toMatch(/usgs:|eonet:|argus:|flights:|firms:/);
  expect(modelFacing).not.toContain("Hurricane Synthetic");
  for (const item of pack.items) {
    expect(Object.keys(item).sort()).toEqual(
      item.detector ? ["detector", "facts", "id", "kind"] : ["facts", "id", "kind"],
    );
    expect(item.facts.title).toBeUndefined();
    expect(["flight_frame", "aircraft_track"]).not.toContain(item.kind);
  }
  // Neither does the request the brief sends.
  const client = new FakeModelClient([textResult(bulletsJson([], []))]);
  await generateBrief(db, { windowEnd: T0, clientKey: null, client, now: T0 }).catch(() => null);
  const sent = JSON.stringify(client.calls);
  for (const a of scene.aircraft) expect(sent).not.toContain(a);
});

test("an empty window stores nothing and never calls the model", async () => {
  const db = await freshDb();
  const client = new FakeModelClient([]);
  const out = await generateBrief(db, { windowEnd: T0, clientKey: "k", client, now: T0 });
  expect(out.status).toBe("empty");
  expect(client.calls).toHaveLength(0);
  const rs = await db.execute("SELECT COUNT(*) AS n FROM briefs");
  expect(Number(rs.rows[0]?.n)).toBe(0);
  expect((await latestBriefPayload(db, T0)).reason).toMatch(/^No brief yet\./);
});

async function threeQuakes() {
  const db = await freshDb();
  const quakes = [
    quake("ci1", { mag: 4.63, t: T0 - 2 * HOUR }),
    quake("ci2", { mag: 3.1, t: T0 - 3 * HOUR, lat: 40, lon: -120 }),
    quake("ci3", { mag: 2.5, t: T0 - 4 * HOUR, lat: 45, lon: -125 }),
  ];
  await insertEvents(db, quakes, "ingest", T0);
  return { db, quakes };
}

const GOOD = [
  "The strongest quake had magnitude 4.63.",
  "Another quake reached magnitude 3.1.",
  "A smaller quake measured magnitude 2.5.",
  "The strongest quake struck at 10:00 UTC.",
  "All of them were reported on 2026-09-23.",
];
const GOOD_IDS = [["E1"], ["E2"], ["E3"], ["E1"], ["E1", "E2", "E3"]];

test("a brief with a rounded number is retried once with the violations, then published", async () => {
  const { db, quakes } = await threeQuakes();
  const rounded = [...GOOD];
  rounded[0] = "The strongest quake had magnitude 4.6.";
  const client = new FakeModelClient([
    textResult(bulletsJson(rounded, GOOD_IDS)),
    textResult(bulletsJson(GOOD, GOOD_IDS)),
  ]);
  const brief = await generateBrief(db, { windowEnd: T0, clientKey: "client-a", client, now: T0 });
  if (brief.status === "empty") throw new Error("expected a brief");

  expect(brief.status).toBe("published");
  expect(brief.checkResult.attempts).toBe(2);
  expect(brief.checkResult.numbersChecked).toBeGreaterThan(0);
  expect(client.calls).toHaveLength(2);
  const first = client.calls[0] as ModelRequest;
  expect(first.system).toBe(BRIEF_SYSTEM_PROMPT);
  expect(first.maxTokens).toBe(config.model.briefMaxTokens);
  expect(first.outputSchema).toBeDefined();
  const retry = client.calls[1] as ModelRequest;
  expect(retry.messages).toHaveLength(3);
  const retryText = String(retry.messages[2]?.content);
  expect(retryText).toContain("Bullet 1: 4.6 is not in the cited facts");
  expect(retryText).not.toContain("usgs:");
  // Pack references are mapped back to stored version ids.
  expect(brief.bullets[0]?.event_ids).toEqual([quakes[0]?.id]);
  expect(brief.bullets[4]?.event_ids).toEqual(quakes.map((q) => q.id));
  // Two API calls, one brief-run use of the rate limit.
  const rl = await db.execute("SELECT route, count FROM rate_limits");
  expect(rl.rows.map((r) => [String(r.route), Number(r.count)])).toEqual([["briefRun:hour", 1]]);
  expect(brief.costMicros).toBeGreaterThan(0);

  const payload = await latestBriefPayload(db, T0 + MINUTE);
  expect(payload.brief?.id).toBe(brief.id);
  expect(payload.brief?.bullets).toEqual(brief.bullets);
  expect(payload.brief?.numbersChecked).toBe(brief.checkResult.numbersChecked);
  expect(payload.brief?.model).toBe(config.model.id);

  // Same data again: both answers come from the cache, nothing is spent, the brief is published.
  const cachedClient = new FakeModelClient([]);
  const again = await generateBrief(db, {
    windowEnd: T0,
    clientKey: "client-a",
    client: cachedClient,
    now: T0 + HOUR,
  });
  expect(cachedClient.calls).toHaveLength(0);
  expect(again.status).toBe("published");
  if (again.status !== "empty") expect(again.costMicros).toBe(0);
});

test("a brief that fails twice is stored as failed and never served", async () => {
  const { db } = await threeQuakes();
  const bad = [...GOOD];
  bad[1] = "Another quake reached magnitude three.";
  const client = new FakeModelClient([
    textResult(bulletsJson(bad, GOOD_IDS)),
    textResult(bulletsJson(bad.slice(0, 4), GOOD_IDS)),
  ]);
  const brief = await generateBrief(db, { windowEnd: T0, clientKey: null, client, now: T0 });
  if (brief.status === "empty") throw new Error("expected a brief");
  expect(brief.status).toBe("failed");
  expect(brief.checkResult.attempts).toBe(1 + config.brief.maxRetries);
  expect(brief.checkResult.problems.join(" ")).toContain(
    "Write exactly 5 bullets; this answer has 4.",
  );
  expect(brief.checkResult.violations.map((v) => v.kind)).toContain("number_word");
  const rows = await db.execute("SELECT status, check_result FROM briefs");
  expect(rows.rows.map((r) => String(r.status))).toEqual(["failed"]);

  const payload = await latestBriefPayload(db, T0 + MINUTE);
  expect(payload.brief).toBeNull();
  expect(payload.reason).toContain("No brief passed the number check");
  expect(copyViolations(payload.reason ?? "")).toEqual([]);
});

test("GET /api/brief serves only briefs from the retention window, as of now", async () => {
  const { db } = await threeQuakes();
  const client = new FakeModelClient([textResult(bulletsJson(GOOD, GOOD_IDS))]);
  const brief = await generateBrief(db, { windowEnd: T0, clientKey: null, client, now: T0 });
  expect(brief.status).toBe("published");
  expect((await latestBriefPayload(db, T0)).brief).not.toBeNull();
  // Before it was written, and after the retention window, it is not served.
  expect((await latestBriefPayload(db, T0 - MINUTE)).brief).toBeNull();
  expect((await latestBriefPayload(db, T0 + (config.retention.hours + 1) * HOUR)).brief).toBeNull();
});

test("check-briefs re-checks every published brief and skips failed ones", async () => {
  const { db } = await threeQuakes();
  await generateBrief(db, {
    windowEnd: T0,
    clientKey: null,
    client: new FakeModelClient([textResult(bulletsJson(GOOD, GOOD_IDS))]),
    now: T0,
  });
  const bad = [...GOOD];
  bad[0] = "The strongest quake had magnitude 4.6.";
  // A window holding only the oldest quake: a different pack, so no cached answer applies.
  const failing = new FakeModelClient([
    textResult(bulletsJson(bad, GOOD_IDS)),
    textResult(bulletsJson(bad, GOOD_IDS)),
  ]);
  const failed = await generateBrief(db, {
    windowEnd: T0 - 3.5 * HOUR,
    clientKey: null,
    client: failing,
    now: T0 + MINUTE,
  });
  expect(failed.status).toBe("failed");
  expect(failing.calls).toHaveLength(2);
  const clean = await checkStoredBriefs(db);
  expect(clean).toMatchObject({ briefsChecked: 1, failedBriefsSkipped: 1, violations: 0 });
  expect(clean.numbersChecked).toBeGreaterThan(0);

  // A published brief whose number is not in its cited event, and one citing a missing event.
  await db.execute({
    sql: `INSERT INTO briefs (id, created_at, window_start, window_end, input_digest, model, bullets, check_result, status)
          VALUES ('tampered', ?, ?, ?, 'x', 'm', ?, '{}', 'published')`,
    args: [
      T0 + HOUR,
      T0 - 24 * HOUR,
      T0,
      JSON.stringify([
        {
          text: "A quake reached magnitude 9.9.",
          event_ids: ["usgs:ci1@" + (T0 - 2 * HOUR + MINUTE)],
        },
        { text: "Nothing here has a number.", event_ids: ["usgs:missing@1"] },
      ]),
    ],
  });
  const dirty = await checkStoredBriefs(db);
  expect(dirty.briefsChecked).toBe(2);
  expect(dirty.violations).toBe(2);
  expect(dirty.unresolvedCitations).toBe(1);
  expect(dirty.lines.join("\n")).toContain("tampered bullet 1: number_not_in_facts");
});

test("the brief prompt states the checker's rules and follows the copy rules", () => {
  expect(PROMPT_VERSION).toMatch(/^brief-/);
  for (const phrase of [
    "copy every number exactly",
    "Never write a number that is not in a cited fact",
    "twice",
    "fold",
    "em dash",
    "heat detections",
    "an aircraft circled",
    "general information",
    "English",
  ]) {
    expect(BRIEF_SYSTEM_PROMPT).toContain(phrase);
  }
  for (const word of [
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
  ]) {
    expect(BRIEF_SYSTEM_PROMPT).toContain(word);
  }
  expect(BRIEF_SYSTEM_PROMPT).not.toMatch(/[\u2013\u2014]/);
});
