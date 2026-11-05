// POST /api/brief/run {windowEnd?} : writes one brief. Called by the ingest worker with the shared
// scheduler secret; also rate limited per client and capped per day (src/model/call.ts).
import { timingSafeEqual } from "node:crypto";
import { generateBrief } from "../../../../brief/generate.ts";
import { getDb } from "../../../../db/client.ts";
import { nowMs } from "../../../../lib/clock.ts";
import { sha256Hex } from "../../../../lib/digest.ts";
import { utcDay } from "../../../../lib/time.ts";
import { describeModelError } from "../../../../model/call.ts";
import { createModelClient } from "../../../../model/client.ts";
import { clientIpFrom, clientKey } from "../../../../model/ratelimit.ts";

/** How far past the server clock a windowEnd may be (clock skew between worker and server). */
const FUTURE_SLACK_MS = 60_000;

function fail(status: number, error: string, retryAfterSeconds?: number) {
  return Response.json(
    { error, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) },
    {
      status,
      headers: retryAfterSeconds === undefined ? {} : { "Retry-After": String(retryAfterSeconds) },
    },
  );
}

/** Constant-time comparison of the header against the secret. */
function secretMatches(given: string | null, secret: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(sha256Hex(given), "hex");
  const b = Buffer.from(sha256Hex(secret), "hex");
  return timingSafeEqual(a, b);
}

function parseWindowEnd(v: unknown, now: number): number | null {
  if (v === undefined || v === null) return now;
  const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms) || !Number.isInteger(ms) || ms <= 0) return null;
  return ms <= now + FUTURE_SLACK_MS ? ms : null;
}

export async function POST(req: Request) {
  const secret = process.env.ARGUS_SCHEDULER_SECRET;
  if (!secret) {
    return fail(401, "Brief runs are turned off: set ARGUS_SCHEDULER_SECRET on the server.");
  }
  if (!secretMatches(req.headers.get("x-argus-scheduler"), secret)) {
    return fail(
      401,
      "The scheduler secret is missing or wrong. Send it in the x-argus-scheduler header.",
    );
  }

  let body: unknown = {};
  const text = await req.text();
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return fail(400, 'The body is not JSON. Send {} or {"windowEnd": <epoch ms>}.');
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail(400, 'The body must be a JSON object, such as {"windowEnd": 1790200000000}.');
  }

  const now = nowMs();
  const windowEnd = parseWindowEnd((body as Record<string, unknown>).windowEnd, now);
  if (windowEnd === null) {
    return fail(
      400,
      "The windowEnd field must be epoch milliseconds or an ISO date, and not in the future. Leave it out to use now.",
    );
  }

  try {
    const db = await getDb();
    const key = clientKey(clientIpFrom(req.headers), utcDay(now));
    const brief = await generateBrief(db, {
      windowEnd,
      clientKey: key,
      client: createModelClient(),
      now,
    });
    if (brief.status === "empty") {
      return Response.json({
        status: "empty",
        windowStart: brief.windowStart,
        windowEnd: brief.windowEnd,
        message: "No events in the window, so no brief was written.",
      });
    }
    return Response.json({
      status: brief.status,
      id: brief.id,
      windowStart: brief.windowStart,
      windowEnd: brief.windowEnd,
      attempts: brief.checkResult.attempts,
      numbersChecked: brief.checkResult.numbersChecked,
      violations: brief.checkResult.violations.length + brief.checkResult.problems.length,
      inputTokens: brief.inputTokens,
      outputTokens: brief.outputTokens,
      costMicros: brief.costMicros,
    });
  } catch (err) {
    const known = describeModelError(err, "brief");
    if (known) return fail(known.status, known.error, known.retryAfterSeconds);
    console.error("POST /api/brief/run failed:", err instanceof Error ? err.message : err);
    return fail(500, "The brief could not be written. Check the server log and try again.");
  }
}
