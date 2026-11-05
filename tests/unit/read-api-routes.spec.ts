// The route handlers themselves: input validation, status codes, Cache-Control, and the shapes.
// They run against the process-wide client from getDb(), pointed at an in-memory database, with
// the clock frozen through ARGUS_NOW.
import { expect, test } from "@playwright/test";
// Node resolves the CommonJS entry by its file name outside the Next bundler.
import { NextRequest } from "next/server.js";
import {
  FIRE_DATA,
  IMMUTABLE_VERSIONS,
  NO_STORE,
  RECENT_DATA,
  SERVER_ERROR,
  SOME_MISSING,
} from "../../src/api/server/respond.ts";
import { GET as eventsRoute } from "../../src/app/api/events/route.ts";
import { GET as eventsLayerRoute } from "../../src/app/api/layers/events/route.ts";
import { GET as firesRoute } from "../../src/app/api/layers/fires/route.ts";
import { GET as flightsRoute } from "../../src/app/api/layers/flights/route.ts";
import { GET as quakesRoute } from "../../src/app/api/layers/quakes/route.ts";
import { GET as replayRoute } from "../../src/app/api/replay/route.ts";
import { GET as statusRoute } from "../../src/app/api/status/route.ts";
import { copyViolations } from "../../src/check/copy-rules.ts";
import { getDb } from "../../src/db/client.ts";
import { seedUsgs, USGS_WINDOW } from "../fixtures/read-api/seed.ts";

const NOW = USGS_WINDOW.to;
const saved = { url: process.env.DATABASE_URL, now: process.env.ARGUS_NOW };

test.beforeAll(async () => {
  process.env.DATABASE_URL = ":memory:";
  process.env.ARGUS_NOW = String(NOW);
  await seedUsgs(await getDb());
});

test.afterAll(() => {
  for (const [key, value] of [
    ["DATABASE_URL", saved.url],
    ["ARGUS_NOW", saved.now],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const req = (path: string) => new NextRequest(`http://localhost${path}`);

async function expectBadRequest(res: Response): Promise<string> {
  expect(res.status).toBe(400);
  expect(res.headers.get("cache-control")).toBe(NO_STORE);
  const body = (await res.json()) as { error?: unknown };
  expect(Object.keys(body)).toEqual(["error"]);
  const error = String(body.error);
  expect(error).toMatch(/^[A-Z]/);
  expect(copyViolations(error)).toEqual([]);
  return error;
}

test("status is never cached and uses the frozen clock", async () => {
  const res = await statusRoute();
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe(NO_STORE);
  const body = (await res.json()) as { now: number; sources: Record<string, { state: string }> };
  expect(body.now).toBe(NOW);
  expect(Object.keys(body.sources)).toEqual(["quakes", "fires", "flights", "satellites", "events"]);
  // The seed fetched USGS after the frozen now, so the quakes source reads live.
  expect(body.sources.quakes?.state).toBe("live");
  expect(body.sources.satellites?.state).toBe("stale");
});

test("layer routes validate their windows and answer with the payload shapes", async () => {
  const w = `from=${USGS_WINDOW.from}&to=${USGS_WINDOW.to}`;
  const quakes = await quakesRoute(req(`/api/layers/quakes?${w}`));
  expect(quakes.status).toBe(200);
  expect(quakes.headers.get("cache-control")).toBe(RECENT_DATA);
  const body = (await quakes.json()) as { layer: string; items: unknown[]; from: number };
  expect(body).toMatchObject({ layer: "quakes", from: USGS_WINDOW.from, to: USGS_WINDOW.to });
  expect(body.items).toHaveLength(5);

  // Defaults: the 24 hours before now.
  const byDefault = (await (await quakesRoute(req("/api/layers/quakes"))).json()) as {
    from: number;
    to: number;
  };
  expect(byDefault).toMatchObject({ from: NOW - 86_400_000, to: NOW });

  await expectBadRequest(await quakesRoute(req("/api/layers/quakes?from=yesterday")));
  await expectBadRequest(await quakesRoute(req("/api/layers/quakes?from=")));
  await expectBadRequest(await quakesRoute(req(`/api/layers/quakes?from=${NOW}&to=${NOW}`)));
  await expectBadRequest(await quakesRoute(req(`/api/layers/quakes?from=0&to=${NOW}`)));
  await expectBadRequest(await quakesRoute(req("/api/layers/quakes?to=-5")));

  const events = await eventsLayerRoute(req(`/api/layers/events?${w}&wildfires=1`));
  expect(events.status).toBe(200);
  expect(await events.json()).toEqual({ layer: "events", ...USGS_WINDOW, items: [] });
  await expectBadRequest(await eventsLayerRoute(req(`/api/layers/events?${w}&wildfires=yes`)));

  const fires = await firesRoute(req(`/api/layers/fires?at=${NOW}`));
  expect(fires.status).toBe(200);
  expect(fires.headers.get("cache-control")).toBe(FIRE_DATA);
  expect(await fires.json()).toEqual({
    layer: "fires",
    from: NOW - 86_400_000,
    to: NOW,
    items: [],
  });
  await expectBadRequest(await firesRoute(req("/api/layers/fires?at=1e12")));

  const flights = await flightsRoute(req("/api/layers/flights"));
  expect(flights.status).toBe(200);
  expect(await flights.json()).toEqual({
    layer: "flights",
    from: NOW - 30 * 60_000,
    to: NOW,
    frameTimes: [],
    items: [],
  });
  await expectBadRequest(await flightsRoute(req("/api/layers/flights?at=now")));

  const replay = await replayRoute(req(`/api/replay?${w}`));
  expect(replay.status).toBe(200);
  expect(replay.headers.get("cache-control")).toBe(RECENT_DATA);
  const summary = (await replay.json()) as Record<string, unknown>;
  expect(Object.keys(summary).sort()).toEqual(
    ["events", "fires", "flights", "from", "gaps", "quakes", "to"].sort(),
  );
  await expectBadRequest(await replayRoute(req(`/api/replay?from=${NOW + 1}&to=${NOW}`)));
});

test("the events route checks ids and caches found versions longer", async () => {
  const layer = (await (
    await quakesRoute(req(`/api/layers/quakes?from=${USGS_WINDOW.from}&to=${USGS_WINDOW.to}`))
  ).json()) as { items: Array<{ id: string }> };
  const id = layer.items[0]?.id ?? "";

  const found = await eventsRoute(req(`/api/events?ids=${encodeURIComponent(id)}`));
  expect(found.status).toBe(200);
  expect(found.headers.get("cache-control")).toBe(IMMUTABLE_VERSIONS);
  const body = (await found.json()) as { events: Array<{ id: string }>; missing: string[] };
  expect(body.events.map((e) => e.id)).toEqual([id]);
  expect(body.missing).toEqual([]);

  const some = await eventsRoute(req(`/api/events?ids=${encodeURIComponent(`${id},usgs:gone@1`)}`));
  expect(some.headers.get("cache-control")).toBe(SOME_MISSING);
  expect(((await some.json()) as { missing: string[] }).missing).toEqual(["usgs:gone@1"]);

  await expectBadRequest(await eventsRoute(req("/api/events")));
  await expectBadRequest(await eventsRoute(req("/api/events?ids=")));
  await expectBadRequest(await eventsRoute(req("/api/events?ids=USGS:loud")));
  await expectBadRequest(await eventsRoute(req("/api/events?ids=usgs:")));
  await expectBadRequest(await eventsRoute(req(`/api/events?ids=usgs:${"x".repeat(201)}`)));
  await expectBadRequest(
    await eventsRoute(req(`/api/events?ids=${encodeURIComponent("usgs:a b")}`)),
  );
  const many = Array.from({ length: 51 }, (_, i) => `usgs:q${i}@1`).join(",");
  const tooMany = await expectBadRequest(await eventsRoute(req(`/api/events?ids=${many}`)));
  expect(tooMany).toContain("50");
  const fifty = Array.from({ length: 50 }, (_, i) => `usgs:q${i}@1`).join(",");
  expect((await eventsRoute(req(`/api/events?ids=${fifty}`))).status).toBe(200);
});

test("a server fault answers 500 with plain words", async () => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  process.env.ARGUS_NOW = "not a date";
  try {
    const res = await statusRoute();
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    expect(await res.json()).toEqual({ error: SERVER_ERROR });
    expect(copyViolations(SERVER_ERROR)).toEqual([]);
    expect(errors).toHaveLength(1);
  } finally {
    console.error = original;
    process.env.ARGUS_NOW = String(NOW);
  }
});
