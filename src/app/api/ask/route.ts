// POST /api/ask {question} : Ask Argus. Per-IP rate limit, daily spend cap, and output cache
// (src/model/call.ts). Every answer passed the rule 4 checker; otherwise there is no answer.
import type { AskResponse } from "../../../api/types.ts";
import { answerQuestion, MAX_QUESTION_CHARS } from "../../../ask/loop.ts";
import { getDb } from "../../../db/client.ts";
import { nowMs } from "../../../lib/clock.ts";
import { utcDay } from "../../../lib/time.ts";
import { describeModelError } from "../../../model/call.ts";
import { createModelClient } from "../../../model/client.ts";
import { clientIpFrom, clientKey } from "../../../model/ratelimit.ts";

function reply(body: AskResponse, status = 200) {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (body.retryAfterSeconds !== undefined) headers["Retry-After"] = String(body.retryAfterSeconds);
  return Response.json(body, { status, headers });
}

function refuse(status: number, error: string, retryAfterSeconds?: number) {
  return reply(
    {
      answer: null,
      error,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    },
    status,
  );
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return refuse(400, 'The request is not JSON. Send {"question": "your question"}.');
  }
  const question =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).question
      : undefined;
  if (typeof question !== "string") {
    return refuse(400, 'Send the question as text: {"question": "your question"}.');
  }
  const q = question.trim();
  if (!q) return refuse(400, "Type a question first.");
  if (q.length > MAX_QUESTION_CHARS) {
    return refuse(
      400,
      `Questions can be at most ${MAX_QUESTION_CHARS} characters. Shorten it and try again.`,
    );
  }

  const now = nowMs();
  try {
    const db = await getDb();
    const key = clientKey(clientIpFrom(req.headers), utcDay(now));
    const outcome = await answerQuestion(db, {
      question: q,
      clientKey: key,
      client: createModelClient(),
      now,
    });
    if (outcome.status === "answered") {
      return reply({
        answer: { sentences: outcome.sentences, numbersChecked: outcome.numbersChecked },
      });
    }
    if (outcome.status === "no_answer") {
      return reply({
        answer: null,
        error:
          "Argus found no stored events that answer this question. Try asking about earthquakes, heat detections, natural events, or circling aircraft.",
      });
    }
    return refuse(
      502,
      "Argus could not write an answer that passed the number check. Try asking in a different way.",
    );
  } catch (err) {
    const known = describeModelError(err, "ask");
    if (known) return refuse(known.status, known.error, known.retryAfterSeconds);
    console.error("POST /api/ask failed:", err instanceof Error ? err.message : err);
    return refuse(500, "Ask Argus hit an error on the server. Try again in a minute.");
  }
}
