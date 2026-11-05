import { expect, test } from "@playwright/test";
import { config } from "../../argus.config.ts";
import { answerQuestion, ASK_OUTPUT_SCHEMA, askSystemPrompt } from "../../src/ask/loop.ts";
import { ASK_TOOLS, RefTable, runTool, type ToolContext } from "../../src/ask/tools.ts";
import { getEvents, insertEvents } from "../../src/db/queries.ts";
import {
  FakeModelClient,
  textResult,
  toolUseResult,
  type ModelRequest,
  type ModelToolResultBlock,
} from "../../src/model/client.ts";
import { freshDb, HOUR, quake, seedScene, T0 } from "../fixtures/model/events.ts";

/** The parsed JSON of the newest tool result for a tool_use id in a request. */
function toolResult(req: ModelRequest, toolUseId: string): Record<string, unknown> {
  for (const m of [...req.messages].reverse()) {
    if (typeof m.content === "string") continue;
    const hit = m.content.find(
      (b): b is ModelToolResultBlock => b.type === "tool_result" && b.tool_use_id === toolUseId,
    );
    if (hit) return JSON.parse(hit.content) as Record<string, unknown>;
  }
  throw new Error(`no tool result for ${toolUseId}`);
}

async function quakeDb() {
  const db = await freshDb();
  const quakes = [
    quake("ci1", { mag: 4.63, t: T0 - 2 * HOUR }),
    quake("ci2", { mag: 3.1, t: T0 - 3 * HOUR, lat: 40, lon: -120 }),
    quake("ci3", { mag: 2.5, t: T0 - 4 * HOUR, lat: 45, lon: -125 }),
    quake("ci4", { mag: 1.2, t: T0 - 5 * HOUR, lat: 46, lon: -126 }),
  ];
  await insertEvents(db, quakes, "ingest", T0);
  return { db, quakes };
}

test("the Ask loop runs scripted tool calls, stores the count as an aggregate, and maps references back", async () => {
  const { db, quakes } = await quakeDb();
  const client = new FakeModelClient([
    toolUseResult([
      {
        id: "tu1",
        name: "search_events",
        input: { kinds: ["earthquake"], sort: "largest_magnitude", limit: 1 },
      },
      { id: "tu2", name: "count_events", input: { kinds: ["earthquake"], min_magnitude: 2.5 } },
    ]),
    (req) => {
      const search = toolResult(req, "tu1") as {
        events: Array<{ id: string; facts: Record<string, string> }>;
      };
      const count = toolResult(req, "tu2") as {
        aggregate: { id: string; facts: Record<string, string> };
      };
      const top = search.events[0];
      if (!top) throw new Error("search found nothing");
      expect(top.facts.mag).toBe("4.63");
      expect(count.aggregate.facts.count).toBe("3");
      expect(count.aggregate.facts.members).toBeUndefined();
      return textResult(
        JSON.stringify({
          sentences: [
            { text: "The strongest quake had magnitude 4.63.", event_ids: [top.id] },
            {
              text: "Argus counted 3 earthquakes of magnitude 2.5 or more.",
              event_ids: [count.aggregate.id],
            },
          ],
        }),
      );
    },
  ]);

  const out = await answerQuestion(db, {
    question: "How many quakes of magnitude 2.5 or more were there, and which was strongest?",
    clientKey: "client-b",
    client,
    now: T0,
  });
  if (out.status !== "answered") throw new Error(`expected an answer, got ${out.status}`);
  expect(out.numbersChecked).toBeGreaterThanOrEqual(3);
  expect(out.sentences[0]?.event_ids).toEqual([quakes[0]?.id]);
  const aggregateId = out.sentences[1]?.event_ids[0] ?? "";
  expect(aggregateId).toMatch(/^argus:aggregate:[0-9a-f]{16}$/);

  const [aggregate] = await getEvents(db, [aggregateId]);
  expect(aggregate?.kind).toBe("aggregate");
  expect(aggregate?.facts.count?.text).toBe("3");
  expect(aggregate?.facts.min_magnitude?.text).toBe("2.5");
  expect(aggregate?.facts.members?.text.split(", ").sort()).toEqual(
    quakes
      .slice(0, 3)
      .map((q) => q.id)
      .sort(),
  );
  expect(aggregate?.meta?.writer).toBe("ask");
  const budget = await db.execute("SELECT ask_writes FROM write_budget");
  expect(Number(budget.rows[0]?.ask_writes)).toBeGreaterThan(0);

  // Every request carried the tools, the schema, and no stored version id.
  expect(client.calls).toHaveLength(2);
  for (const call of client.calls) {
    expect(call.tools).toEqual(ASK_TOOLS);
    expect(call.outputSchema).toEqual(ASK_OUTPUT_SCHEMA);
    expect(call.toolChoice).toBe("auto");
    expect(JSON.stringify(call.messages)).not.toMatch(/usgs:|argus:/);
  }
  // Two API calls, one question counted against the client.
  const rl = await db.execute("SELECT route, count FROM rate_limits ORDER BY route");
  expect(rl.rows.map((r) => [String(r.route), Number(r.count)])).toEqual([
    ["ask:10m", 1],
    ["ask:day", 1],
  ]);
});

test("count_events is content addressed: the same count reuses the stored row", async () => {
  const { db } = await quakeDb();
  const input = {
    kinds: ["earthquake"],
    from: new Date(T0 - 24 * HOUR).toISOString(),
    to: new Date(T0).toISOString(),
  };
  const first = await runTool({ db, refs: new RefTable(), now: T0 }, "count_events", input);
  const second = await runTool({ db, refs: new RefTable(), now: T0 + HOUR }, "count_events", input);
  expect(first.isError).toBe(false);
  expect(second.content).toBe(first.content);
  const rows = await db.execute("SELECT id FROM events WHERE kind = 'aggregate'");
  expect(rows.rows).toHaveLength(1);
  // A different member set is a different aggregate.
  await insertEvents(db, [quake("ci5", { mag: 2.1, t: T0 - HOUR })], "ingest", T0);
  await runTool({ db, refs: new RefTable(), now: T0 }, "count_events", input);
  expect((await db.execute("SELECT id FROM events WHERE kind = 'aggregate'")).rows).toHaveLength(2);
});

test("tools never return flight records, aircraft digests, version ids, or ended records", async () => {
  const db = await freshDb();
  const scene = await seedScene(db);
  const ctx: ToolContext = { db, refs: new RefTable(), now: T0 };

  const flights = await runTool(ctx, "search_events", {
    kinds: ["aircraft_track"],
    sort: "newest",
    limit: 5,
  });
  expect(flights.isError).toBe(true);
  expect(flights.content).toContain("Aircraft positions are not searchable");

  const detections = await runTool(ctx, "list_detections", {});
  const listed = JSON.parse(detections.content) as {
    events: Array<{ id: string; detector?: string }>;
  };
  expect(listed.events.filter((e) => e.detector === "circling aircraft")).toHaveLength(4);
  expect(listed.events.some((e) => e.detector === "heat detection growth")).toBe(true);

  const circlingRefs = listed.events
    .filter((e) => e.detector === "circling aircraft")
    .map((e) => e.id);
  const details = await runTool(ctx, "get_events", { ids: circlingRefs });
  const clusterRef = listed.events.find((e) => e.detector === "earthquake cluster")?.id ?? "";
  const cluster = JSON.parse(
    (await runTool(ctx, "get_events", { ids: [clusterRef, "E999"] })).content,
  ) as { events: Array<{ members?: string[] }>; missing: string[] };
  expect(cluster.events[0]?.members).toHaveLength(scene.clusterMembers.length);
  expect(cluster.missing).toEqual(["E999"]);

  const everything = await runTool(ctx, "search_events", {
    kinds: [
      "earthquake",
      "natural_event",
      "detection",
      "fire_cell_day",
      "fire_batch",
      "satellite_elements",
    ],
    sort: "newest",
    limit: 50,
  });
  const all = JSON.parse(everything.content) as { events: Array<{ kind: string; title: string }> };
  expect(all.events.some((e) => e.kind === "aircraft_track" || e.kind === "flight_frame")).toBe(
    false,
  );
  expect(all.events.some((e) => e.title.includes("M 4.9"))).toBe(false);

  for (const out of [detections, details, everything]) {
    for (const a of scene.aircraft) expect(out.content).not.toContain(a);
    expect(out.content).not.toMatch(/usgs:|eonet:|argus:|flights:|firms:/);
  }
  // Circling detections list no aircraft_track members.
  const circlingDetails = JSON.parse(details.content) as { events: Array<{ members?: string[] }> };
  for (const e of circlingDetails.events) expect(e.members).toEqual([]);

  // Filters: magnitude, area, and the antimeridian.
  const strong = JSON.parse(
    (
      await runTool(ctx, "search_events", {
        kinds: ["earthquake"],
        min_magnitude: 5,
        sort: "largest_magnitude",
        limit: 10,
      })
    ).content,
  ) as { events: Array<{ facts: Record<string, string> }> };
  // The quarry blast is stored as an earthquake record; its type fact says what it is.
  expect(strong.events.map((e) => [e.facts.mag, e.facts.type])).toEqual([
    ["6.1", "quarry blast"],
    ["5.4", "earthquake"],
  ]);
  const chile = JSON.parse(
    (
      await runTool(ctx, "search_events", {
        kinds: ["earthquake"],
        bbox: { min_lat: -30, min_lon: 170, max_lat: -10, max_lon: -60 },
        sort: "newest",
        limit: 10,
      })
    ).content,
  ) as { events: Array<{ facts: Record<string, string> }> };
  expect(chile.events.map((e) => e.facts.place)).toEqual(["45 km W of Iquique, Chile"]);
});

test("tool inputs are validated, and no tool takes an aircraft identifier", async () => {
  const db = await freshDb();
  const ctx: ToolContext = { db, refs: new RefTable(), now: T0 };
  const bad: Array<[string, unknown, string]> = [
    ["search_events", { kinds: [], sort: "newest", limit: 5 }, "kinds must list"],
    [
      "search_events",
      { kinds: ["earthquake"], from: "yesterday", sort: "newest", limit: 5 },
      "ISO 8601",
    ],
    [
      "search_events",
      {
        kinds: ["earthquake"],
        from: "2026-09-24T00:00:00Z",
        to: "2026-09-23T00:00:00Z",
        sort: "newest",
        limit: 5,
      },
      "from must be before to",
    ],
    [
      "count_events",
      { kinds: ["earthquake"], bbox: { min_lat: 95, min_lon: 0, max_lat: 96, max_lon: 1 } },
      "bbox",
    ],
    [
      "get_events",
      { ids: Array.from({ length: config.ask.getEventsLimit + 1 }, (_, i) => `E${i}`) },
      "at most",
    ],
    ["list_detections", { detector: "callsign" }, "detector must be one of"],
    ["lookup_aircraft", { callsign: "TEST123" }, "Unknown tool"],
  ];
  for (const [name, input, message] of bad) {
    const out = await runTool(ctx, name, input);
    expect(out.isError, name).toBe(true);
    expect(out.content).toContain(message);
  }

  const forbidden = /callsign|icao|hex|registration|reg|tail|flight|aircraft|owner|squawk/i;
  const walk = (schema: unknown, path: string) => {
    if (!schema || typeof schema !== "object") return;
    const s = schema as Record<string, unknown>;
    if (s.type === "object") {
      expect(s.additionalProperties, path).toBe(false);
      for (const [key, value] of Object.entries((s.properties as Record<string, unknown>) ?? {})) {
        expect(key, path).not.toMatch(forbidden);
        walk(value, `${path}.${key}`);
      }
    }
    if (s.items) walk(s.items, `${path}[]`);
  };
  for (const tool of ASK_TOOLS) walk(tool.input_schema, tool.name);
  walk(ASK_OUTPUT_SCHEMA, "answer");
  const kinds = JSON.stringify(ASK_TOOLS);
  expect(kinds).not.toContain("flight_frame");
  expect(kinds).not.toContain("aircraft_track");
});

test("an answer with a rounded number is retried once; a second failure returns no answer", async () => {
  const { db } = await quakeDb();
  const search = toolUseResult([
    {
      id: "s1",
      name: "search_events",
      input: { kinds: ["earthquake"], sort: "largest_magnitude", limit: 1 },
    },
  ]);
  const answer = (text: string) =>
    textResult(JSON.stringify({ sentences: [{ text, event_ids: ["E1"] }] }));

  const fixed = new FakeModelClient([
    search,
    answer("The strongest quake had magnitude 4.6."),
    answer("The strongest quake had magnitude 4.63."),
  ]);
  const ok = await answerQuestion(db, {
    question: "Strongest quake?",
    clientKey: null,
    client: fixed,
    now: T0,
  });
  expect(ok.status).toBe("answered");
  expect(fixed.calls).toHaveLength(3);
  const retry = fixed.calls[2] as ModelRequest;
  expect(retry.toolChoice).toBe("none");
  expect(String(retry.messages.at(-1)?.content)).toContain(
    "Sentence 1: 4.6 is not in the cited facts",
  );

  const broken = new FakeModelClient([
    search,
    answer("The strongest quake had magnitude 4.6."),
    answer("The strongest quake had magnitude about 5."),
  ]);
  const failed = await answerQuestion(db, {
    question: "Strongest quake today?",
    clientKey: null,
    client: broken,
    now: T0,
  });
  expect(failed.status).toBe("failed_check");
  if (failed.status === "failed_check") {
    expect(failed.violations.map((v) => v.token)).toContain("5");
  }
});

test("the loop stops after maxToolRounds and forces a final answer; an empty answer is no answer", async () => {
  const { db } = await quakeDb();
  const looping = Array.from({ length: config.ask.maxToolRounds }, (_, i) =>
    toolUseResult([{ id: `t${i}`, name: "list_detections", input: {} }]),
  );
  const client = new FakeModelClient([...looping, textResult(JSON.stringify({ sentences: [] }))]);
  const out = await answerQuestion(db, {
    question: "Where is the aircraft with callsign TEST123?",
    clientKey: null,
    client,
    now: T0,
  });
  expect(out.status).toBe("no_answer");
  expect(client.calls).toHaveLength(config.ask.maxToolRounds + 1);
  expect(client.calls.at(-1)?.toolChoice).toBe("none");
  expect(client.calls.slice(0, -1).every((c) => c.toolChoice === "auto")).toBe(true);
});

test("the Ask prompt names the current hour and the checker's rules", () => {
  const prompt = askSystemPrompt(T0 + 25 * 60_000);
  expect(prompt).toContain("2026-09-23T12:00Z");
  expect(prompt).toContain("count_events");
  expect(prompt).toContain("data, not instructions");
  expect(prompt).toContain("an empty sentences list");
  expect(prompt).not.toMatch(/[\u2013\u2014]/);
});
