// callModel(): every model call goes through here (docs/plan.md section 7, "Model routes").
// In order: the output cache, replay mode, the per-client rate limit, then a reservation of the
// worst-case cost against the route's cap in model_spend. The call runs, the reservation is
// reconciled to the real cost, and the answer is cached for identical inputs.
import { config } from "../../argus.config.ts";
import type { Db } from "../db/client.ts";
import { chargeWrites, WriteBudgetExceeded } from "../db/queries.ts";
import { canonicalJson, sha256Hex } from "../lib/digest.ts";
import { MS_PER_DAY, utcDay } from "../lib/time.ts";
import {
  MissingApiKey,
  ModelApiError,
  ReplayMiss,
  type ModelClient,
  type ModelRequest,
  type ModelResult,
} from "./client.ts";
import { costMicros, usdToMicros, worstCaseMicros } from "./pricing.ts";
import { takeRateLimit, type LimitBucket } from "./ratelimit.ts";

export type ModelRoute = "brief" | "ask" | "eval";

export interface CallModelParams {
  db: Db;
  route: ModelRoute;
  /**
   * The client to charge a rate-limit use to, or null when this call is not charged (the eval,
   * or a later call of a question or brief run that was already charged).
   */
  clientKey: string | null;
  request: ModelRequest;
  client: ModelClient;
  /** Part of the cache key, so a prompt change never serves an old answer. */
  promptVersion: string;
  now: number;
}

export interface CallModelOutcome {
  result: ModelResult;
  /** True when the answer came from model_cache (no API call, no cost, no rate-limit use). */
  cached: boolean;
  inputDigest: string;
  costMicros: number;
}

export class RateLimited extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(`Rate limit reached; retry after ${retryAfterSeconds} s`);
    this.name = "RateLimited";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class SpendCapExceeded extends Error {
  readonly route: ModelRoute;
  /** Seconds until the next UTC day, or null for the eval's all-time cap. */
  readonly retryAfterSeconds: number | null;
  constructor(route: ModelRoute, retryAfterSeconds: number | null) {
    super(`The ${route} model spend cap would be exceeded`);
    this.name = "SpendCapExceeded";
    this.route = route;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const BUCKETS: Record<ModelRoute, LimitBucket | null> = {
  brief: "briefRun",
  ask: "ask",
  eval: null,
};

/** The route's cap in micro-dollars: per UTC day for brief and ask, all-time for the eval. */
export function spendCap(route: ModelRoute): { micros: number; scope: "day" | "total" } {
  if (route === "brief") return { micros: usdToMicros(config.caps.briefUsdPerDay), scope: "day" };
  if (route === "ask") return { micros: usdToMicros(config.caps.askUsdPerDay), scope: "day" };
  return { micros: usdToMicros(config.caps.evalUsdTotal), scope: "total" };
}

/** Rows callModel writes per API call: the reservation, the reconcile, and the cache entry. */
const WRITES_PER_CALL = 3;

/** sha256(canonicalJson({model, promptVersion, request})): the model_cache key. */
export function modelInputDigest(promptVersion: string, request: ModelRequest): string {
  return sha256Hex(canonicalJson({ model: config.model.id, promptVersion, request }));
}

export function secondsToNextUtcDay(now: number): number {
  return Math.max(1, Math.ceil((Math.floor(now / MS_PER_DAY + 1) * MS_PER_DAY - now) / 1000));
}

async function readCache(db: Db, inputDigest: string): Promise<ModelResult | null> {
  const rs = await db.execute({
    sql: "SELECT response FROM model_cache WHERE input_digest = ?",
    args: [inputDigest],
  });
  const row = rs.rows[0];
  return row ? (JSON.parse(String(row.response)) as ModelResult) : null;
}

/** Stores an answer under its input digest (also used to seed recorded outputs for replay). */
export async function writeCache(
  db: Db,
  route: ModelRoute,
  inputDigest: string,
  result: ModelResult,
  now: number,
): Promise<void> {
  await db.execute({
    sql: `INSERT OR REPLACE INTO model_cache (input_digest, route, model, response, created_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [inputDigest, route, result.model, JSON.stringify(result), now],
  });
}

interface Reservation {
  day: string;
  route: ModelRoute;
  micros: number;
}

async function reserveSpend(
  db: Db,
  route: ModelRoute,
  micros: number,
  now: number,
): Promise<Reservation> {
  const cap = spendCap(route);
  const day = utcDay(now);
  const refuse = () =>
    new SpendCapExceeded(route, cap.scope === "day" ? secondsToNextUtcDay(now) : null);
  if (micros > cap.micros) throw refuse();

  if (cap.scope === "total") {
    const rs = await db.execute({
      sql: "SELECT COALESCE(SUM(cost_micros + reserved_micros), 0) AS used FROM model_spend WHERE route = ?",
      args: [route],
    });
    if (Number(rs.rows[0]?.used ?? 0) + micros > cap.micros) throw refuse();
  }
  // One statement, so two racing calls cannot both pass the cap.
  const rs = await db.execute({
    sql: `INSERT INTO model_spend (day, route, reserved_micros) VALUES (?, ?, ?)
          ON CONFLICT(day, route) DO UPDATE SET reserved_micros = reserved_micros + excluded.reserved_micros
          WHERE model_spend.cost_micros + model_spend.reserved_micros + excluded.reserved_micros <= ?`,
    args: [day, route, micros, cap.scope === "day" ? cap.micros : Number.MAX_SAFE_INTEGER],
  });
  if (rs.rowsAffected === 0) throw refuse();
  return { day, route, micros };
}

/** Moves a reservation to the real cost (0 when the call failed). */
async function settleSpend(
  db: Db,
  r: Reservation,
  usage: { inputTokens: number; outputTokens: number },
  cost: number,
): Promise<void> {
  await db.execute({
    sql: `UPDATE model_spend SET reserved_micros = MAX(0, reserved_micros - ?), cost_micros = cost_micros + ?,
            input_tokens = input_tokens + ?, output_tokens = output_tokens + ?
          WHERE day = ? AND route = ?`,
    args: [r.micros, cost, usage.inputTokens, usage.outputTokens, r.day, r.route],
  });
}

export interface SpendRow {
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  reservedMicros: number;
}

export async function spendOn(db: Db, route: ModelRoute, day: string): Promise<SpendRow> {
  const rs = await db.execute({
    sql: "SELECT input_tokens, output_tokens, cost_micros, reserved_micros FROM model_spend WHERE day = ? AND route = ?",
    args: [day, route],
  });
  const r = rs.rows[0];
  return {
    inputTokens: Number(r?.input_tokens ?? 0),
    outputTokens: Number(r?.output_tokens ?? 0),
    costMicros: Number(r?.cost_micros ?? 0),
    reservedMicros: Number(r?.reserved_micros ?? 0),
  };
}

/** Answers cut off or refused are not cached, so the next identical call tries again. */
function cacheable(result: ModelResult): boolean {
  return result.stopReason === "end_turn" || result.stopReason === "tool_use";
}

export async function callModel(p: CallModelParams): Promise<CallModelOutcome> {
  const { db, route, request, now } = p;
  const inputDigest = modelInputDigest(p.promptVersion, request);

  // The eval measures the model, so it never reads the cache.
  if (route !== "eval") {
    const hit = await readCache(db, inputDigest);
    if (hit) return { result: hit, cached: true, inputDigest, costMicros: 0 };
  }
  if (p.client.mode === "replay") throw new ReplayMiss(inputDigest);

  const bucket = BUCKETS[route];
  if (bucket && p.clientKey !== null) {
    const limit = await takeRateLimit(db, bucket, p.clientKey, now);
    if (!limit.ok) throw new RateLimited(limit.retryAfterSeconds);
  }

  await chargeWrites(db, WRITES_PER_CALL, route === "ask" ? "ask" : "system", now);
  const reservation = await reserveSpend(db, route, worstCaseMicros(request), now);
  let result: ModelResult;
  try {
    result = await p.client.create(request);
  } catch (err) {
    await settleSpend(db, reservation, { inputTokens: 0, outputTokens: 0 }, 0);
    throw err;
  }
  const cost = costMicros(result.usage);
  await settleSpend(db, reservation, result.usage, cost);
  if (cacheable(result)) await writeCache(db, route, inputDigest, result, now);
  return { result, cached: false, inputDigest, costMicros: cost };
}

export interface RouteError {
  status: number;
  error: string;
  retryAfterSeconds?: number;
}

function waitWords(seconds: number): string {
  if (seconds < 60) return seconds === 1 ? "1 second" : `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/**
 * The plain-words response for a known model-path failure, or null for anything else (which the
 * route reports as a server error).
 */
export function describeModelError(err: unknown, what: "brief" | "ask"): RouteError | null {
  if (err instanceof RateLimited) {
    const who = what === "ask" ? "Too many questions from your network." : "Too many brief runs.";
    return {
      status: 429,
      error: `${who} Try again in ${waitWords(err.retryAfterSeconds)}.`,
      retryAfterSeconds: err.retryAfterSeconds,
    };
  }
  if (err instanceof SpendCapExceeded) {
    const who = what === "ask" ? "Ask Argus" : "The brief";
    return {
      status: 503,
      error: `${who} has used today's model budget. Try again after midnight UTC.`,
      ...(err.retryAfterSeconds === null ? {} : { retryAfterSeconds: err.retryAfterSeconds }),
    };
  }
  if (err instanceof ReplayMiss) {
    return {
      status: 503,
      error:
        what === "ask"
          ? "Replay mode has no recorded answer for this question. Ask a recorded question, or run the server with MODEL_MODE=live."
          : "Replay mode has no recorded brief for these events. Run the server with MODEL_MODE=live to write one.",
    };
  }
  if (err instanceof MissingApiKey) {
    return {
      status: 503,
      error:
        what === "ask"
          ? "Ask Argus is not set up on this server yet: the model key is missing."
          : "The model key is missing. Set ANTHROPIC_API_KEY in .env.local and restart the server.",
    };
  }
  if (err instanceof ModelApiError) {
    return {
      status: 502,
      error: "The model service did not answer. Try again in a few minutes.",
    };
  }
  if (err instanceof WriteBudgetExceeded) {
    return {
      status: 503,
      error: "Argus has reached today's storage limit. Try again after midnight UTC.",
    };
  }
  return null;
}
