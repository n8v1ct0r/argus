import { expect, test } from "@playwright/test";
import { config } from "../../argus.config.ts";
import { copyViolations } from "../../src/check/copy-rules.ts";
import { WriteBudgetExceeded } from "../../src/db/queries.ts";
import { utcDay } from "../../src/lib/time.ts";
import {
  callModel,
  describeModelError,
  modelInputDigest,
  RateLimited,
  spendCap,
  spendOn,
  SpendCapExceeded,
  writeCache,
} from "../../src/model/call.ts";
import {
  AnthropicModelClient,
  createModelClient,
  FakeModelClient,
  MissingApiKey,
  ModelApiError,
  ReplayMiss,
  ReplayModelClient,
  textResult,
  type ModelRequest,
} from "../../src/model/client.ts";
import { costMicros, estimateInputTokens, worstCaseMicros } from "../../src/model/pricing.ts";
import { freshDb, HOUR, T0 } from "../fixtures/model/events.ts";

const REQUEST: ModelRequest = {
  system: "You answer tests.",
  messages: [{ role: "user", content: "Say hello." }],
  maxTokens: 100,
};
const VERSION = "test-1";
const DAY = utcDay(T0);

test("a cache hit answers without the client, the rate limit, or any spend", async () => {
  const db = await freshDb();
  const digest = modelInputDigest(VERSION, REQUEST);
  await writeCache(db, "ask", digest, textResult("cached"), T0);
  const client = new FakeModelClient([]);
  const out = await callModel({
    db,
    route: "ask",
    clientKey: "client-a",
    request: REQUEST,
    client,
    promptVersion: VERSION,
    now: T0,
  });
  expect(out.cached).toBe(true);
  expect(out.costMicros).toBe(0);
  expect(out.result.content).toEqual([{ type: "text", text: "cached" }]);
  expect(client.calls).toHaveLength(0);
  expect((await db.execute("SELECT * FROM rate_limits")).rows).toHaveLength(0);
  expect(await spendOn(db, "ask", DAY)).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    costMicros: 0,
    reservedMicros: 0,
  });
});

test("an API answer is cached under its input digest; a prompt version change misses", async () => {
  const db = await freshDb();
  const client = new FakeModelClient([textResult("first"), textResult("second")]);
  const params = {
    db,
    route: "brief" as const,
    clientKey: null,
    request: REQUEST,
    client,
    now: T0,
  };
  const a = await callModel({ ...params, promptVersion: VERSION });
  const b = await callModel({ ...params, promptVersion: VERSION });
  expect([a.cached, b.cached]).toEqual([false, true]);
  expect(b.result).toEqual(a.result);
  expect(b.inputDigest).toBe(a.inputDigest);
  const c = await callModel({ ...params, promptVersion: "test-2" });
  expect(c.cached).toBe(false);
  expect(c.inputDigest).not.toBe(a.inputDigest);
  expect(client.calls).toHaveLength(2);
});

test("replay mode answers from the cache or throws ReplayMiss before any limit or spend", async () => {
  const db = await freshDb();
  const replay = new ReplayModelClient();
  const params = {
    db,
    route: "ask" as const,
    clientKey: "client-a",
    client: replay,
    promptVersion: VERSION,
    now: T0,
  };
  const miss = await callModel({ ...params, request: REQUEST }).catch((e: unknown) => e);
  expect(miss).toBeInstanceOf(ReplayMiss);
  expect((miss as ReplayMiss).inputDigest).toBe(modelInputDigest(VERSION, REQUEST));
  expect((await db.execute("SELECT * FROM rate_limits")).rows).toHaveLength(0);
  expect((await db.execute("SELECT * FROM model_spend")).rows).toHaveLength(0);

  await writeCache(db, "ask", modelInputDigest(VERSION, REQUEST), textResult("recorded"), T0);
  const hit = await callModel({ ...params, request: REQUEST });
  expect(hit.cached).toBe(true);

  expect(createModelClient({ MODEL_MODE: "replay" }).mode).toBe("replay");
  expect(createModelClient({ MODEL_MODE: "live" }).mode).toBe("live");
  expect(createModelClient({}).mode).toBe("live");
});

test("the worst case is reserved during the call and reconciled to the real cost after", async () => {
  const db = await freshDb();
  const reserve = worstCaseMicros(REQUEST);
  expect(reserve).toBe(
    costMicros({ inputTokens: estimateInputTokens(REQUEST), outputTokens: REQUEST.maxTokens }),
  );
  const usage = { inputTokens: 40, outputTokens: 12 };
  const client = new FakeModelClient([
    async () => {
      const during = await spendOn(db, "ask", DAY);
      expect(during.reservedMicros).toBe(reserve);
      expect(during.costMicros).toBe(0);
      return textResult("hello", usage);
    },
  ]);
  const out = await callModel({
    db,
    route: "ask",
    clientKey: null,
    request: REQUEST,
    client,
    promptVersion: VERSION,
    now: T0,
  });
  const cost =
    usage.inputTokens * config.model.usdPerMillionInputTokens +
    usage.outputTokens * config.model.usdPerMillionOutputTokens;
  expect(out.costMicros).toBe(cost);
  expect(await spendOn(db, "ask", DAY)).toEqual({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costMicros: cost,
    reservedMicros: 0,
  });
});

test("a call that would pass the daily cap is refused before the client runs", async () => {
  const db = await freshDb();
  const cap = spendCap("ask");
  expect(cap).toEqual({ micros: config.caps.askUsdPerDay * 1_000_000, scope: "day" });
  await db.execute({
    sql: "INSERT INTO model_spend (day, route, cost_micros) VALUES (?, 'ask', ?)",
    args: [DAY, cap.micros - worstCaseMicros(REQUEST) + 1],
  });
  const client = new FakeModelClient([textResult("never")]);
  const refused = await callModel({
    db,
    route: "ask",
    clientKey: null,
    request: REQUEST,
    client,
    promptVersion: VERSION,
    now: T0,
  }).catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(SpendCapExceeded);
  expect((refused as SpendCapExceeded).retryAfterSeconds).toBe(12 * 3600);
  expect(client.calls).toHaveLength(0);
  expect((await spendOn(db, "ask", DAY)).reservedMicros).toBe(0);

  // The brief has its own cap, and the next UTC day starts fresh.
  const brief = await callModel({
    db,
    route: "brief",
    clientKey: null,
    request: REQUEST,
    client,
    promptVersion: VERSION,
    now: T0,
  });
  expect(brief.cached).toBe(false);
  const tomorrow = await callModel({
    db,
    route: "ask",
    clientKey: null,
    request: { ...REQUEST, maxTokens: 101 },
    client: new FakeModelClient([textResult("ok")]),
    promptVersion: VERSION,
    now: T0 + 24 * HOUR,
  });
  expect(tomorrow.cached).toBe(false);
});

test("the eval never reads the cache and has an all-time cap", async () => {
  const db = await freshDb();
  await writeCache(db, "eval", modelInputDigest(VERSION, REQUEST), textResult("cached"), T0);
  const client = new FakeModelClient([textResult("fresh")]);
  const out = await callModel({
    db,
    route: "eval",
    clientKey: "ignored",
    request: REQUEST,
    client,
    promptVersion: VERSION,
    now: T0,
  });
  expect(out.cached).toBe(false);
  expect((await db.execute("SELECT * FROM rate_limits")).rows).toHaveLength(0);
  const cap = spendCap("eval");
  expect(cap.scope).toBe("total");
  await db.execute({
    sql: "INSERT INTO model_spend (day, route, cost_micros) VALUES ('2026-01-01', 'eval', ?)",
    args: [cap.micros],
  });
  const refused = await callModel({
    db,
    route: "eval",
    clientKey: null,
    request: REQUEST,
    client: new FakeModelClient([textResult("never")]),
    promptVersion: VERSION,
    now: T0,
  }).catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(SpendCapExceeded);
  expect((refused as SpendCapExceeded).retryAfterSeconds).toBeNull();
});

test("a failed call releases its reservation and is not cached", async () => {
  const db = await freshDb();
  const client = new FakeModelClient([
    () => {
      throw new ModelApiError("overloaded", 529);
    },
    textResult("retry works"),
  ]);
  const params = {
    db,
    route: "brief" as const,
    clientKey: null,
    request: REQUEST,
    client,
    promptVersion: VERSION,
    now: T0,
  };
  await expect(callModel(params)).rejects.toBeInstanceOf(ModelApiError);
  expect(await spendOn(db, "brief", DAY)).toMatchObject({ costMicros: 0, reservedMicros: 0 });
  expect((await callModel(params)).cached).toBe(false);
});

test("a rate-limited client is refused with the wait, before any spend", async () => {
  const db = await freshDb();
  const params = {
    db,
    route: "ask" as const,
    clientKey: "client-c",
    promptVersion: VERSION,
    now: T0,
  };
  for (let i = 0; i < config.rateLimits.ask.perTenMinutes; i++) {
    await callModel({
      ...params,
      request: { ...REQUEST, maxTokens: 100 + i },
      client: new FakeModelClient([textResult(`answer ${i}`)]),
    });
  }
  const client = new FakeModelClient([textResult("never")]);
  const limited = await callModel({
    ...params,
    request: { ...REQUEST, maxTokens: 99 },
    client,
  }).catch((e: unknown) => e);
  expect(limited).toBeInstanceOf(RateLimited);
  expect((limited as RateLimited).retryAfterSeconds).toBe(600);
  expect(client.calls).toHaveLength(0);
  // A call that is not charged to a client still runs.
  const uncharged = await callModel({
    ...params,
    clientKey: null,
    request: { ...REQUEST, maxTokens: 98 },
    client,
  });
  expect(uncharged.cached).toBe(false);
});

test("the real client reads the key only when it calls, and fails plainly without one", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const client = new AnthropicModelClient();
    expect(client.mode).toBe("live");
    await expect(client.create(REQUEST)).rejects.toBeInstanceOf(MissingApiKey);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("model errors map to plain-words responses with correct statuses", () => {
  const cases: Array<[unknown, number]> = [
    [new RateLimited(125), 429],
    [new SpendCapExceeded("ask", 3600), 503],
    [new ReplayMiss("abc"), 503],
    [new MissingApiKey(), 503],
    [new ModelApiError("boom", 500), 502],
    [new WriteBudgetExceeded("full"), 503],
  ];
  for (const what of ["ask", "brief"] as const) {
    for (const [err, status] of cases) {
      const d = describeModelError(err, what);
      expect(d?.status).toBe(status);
      expect(d?.error).toMatch(/^[A-Z]/);
      expect(copyViolations(d?.error ?? "")).toEqual([]);
    }
  }
  expect(describeModelError(new RateLimited(125), "ask")).toEqual({
    status: 429,
    error: "Too many questions from your network. Try again in 3 minutes.",
    retryAfterSeconds: 125,
  });
  expect(describeModelError(new Error("other"), "ask")).toBeNull();
});

test("costs are integer micro-dollars from the configured prices", () => {
  expect(costMicros({ inputTokens: 1_000_000, outputTokens: 0 })).toBe(
    config.model.usdPerMillionInputTokens * 1_000_000,
  );
  expect(costMicros({ inputTokens: 0, outputTokens: 1_000_000 })).toBe(
    config.model.usdPerMillionOutputTokens * 1_000_000,
  );
  expect(costMicros({ inputTokens: 8000, outputTokens: 800 })).toBe(12_000);
  // The input bound is never below the request's byte size.
  expect(estimateInputTokens(REQUEST)).toBeGreaterThan(JSON.stringify(REQUEST).length);
});
