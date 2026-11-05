// generateBrief(): facts pack, one structured model call, the rule 4 check, at most
// config.brief.maxRetries retries with the checker's findings, then one briefs row, published or
// failed (docs/plan.md section 3d). A failed brief is stored for the record and never served.
import { config } from "../../argus.config.ts";
import type { BriefBullet, BriefPayload } from "../api/types.ts";
import { checkSentences, type CheckResult, type CheckViolation } from "../check/check-brief.ts";
import type { Db } from "../db/client.ts";
import { chargeWrites, getEvents } from "../db/queries.ts";
import { MS_PER_HOUR } from "../lib/time.ts";
import { callModel } from "../model/call.ts";
import type { ModelClient, ModelMessage, ModelRequest, ModelResult } from "../model/client.ts";
import { buildFactsPack, isAircraftKind } from "./facts.ts";
import {
  BRIEF_SYSTEM_PROMPT,
  briefOutputSchema,
  briefRetryMessage,
  briefUserMessage,
  PROMPT_VERSION,
} from "./prompt.ts";

export interface BriefCheckResult {
  ok: boolean;
  numbersChecked: number;
  violations: CheckViolation[];
  /** Shape problems found before the number check (unreadable JSON, wrong bullet count). */
  problems: string[];
  /** Model answers checked, the first try included. */
  attempts: number;
}

export interface StoredBrief {
  status: "published" | "failed";
  id: string;
  createdAt: number;
  windowStart: number;
  windowEnd: number;
  /** The facts pack digest. */
  inputDigest: string;
  model: string;
  bullets: BriefBullet[];
  checkResult: BriefCheckResult;
  /** Tokens and cost of API calls made for this brief (cache hits cost nothing). */
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export type GenerateBriefResult =
  { status: "empty"; windowStart: number; windowEnd: number } | StoredBrief;

export interface GenerateBriefOptions {
  windowEnd: number;
  /** Charged one brief-run use on the first API call; null charges nothing. */
  clientKey: string | null;
  client: ModelClient;
  now: number;
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function answerText(result: ModelResult): string {
  return result.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
}

/**
 * Reads a structured answer { [key]: [{ text, event_ids }] }. Items that do not have that shape
 * are dropped and reported as problems.
 */
export function parseAnswer(
  result: ModelResult,
  key: "bullets" | "sentences",
): { items: BriefBullet[]; problems: string[] } {
  const problems: string[] = [];
  if (result.stopReason === "max_tokens") {
    problems.push("The answer was cut off before it ended. Write shorter text.");
  }
  if (result.stopReason === "refusal") problems.push("The answer was refused.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(answerText(result));
  } catch {
    return { items: [], problems: [...problems, "The answer was not valid JSON."] };
  }
  const list = isObj(parsed) ? parsed[key] : undefined;
  if (!Array.isArray(list)) {
    return { items: [], problems: [...problems, `The answer has no ${key} list.`] };
  }
  const items: BriefBullet[] = [];
  list.forEach((x: unknown, i) => {
    const ids = isObj(x) ? x.event_ids : undefined;
    if (
      !isObj(x) ||
      typeof x.text !== "string" ||
      !Array.isArray(ids) ||
      !ids.every((id): id is string => typeof id === "string")
    ) {
      problems.push(`Item ${i + 1} is not an object with text and event_ids.`);
      return;
    }
    items.push({ text: x.text.trim(), event_ids: [...ids] });
  });
  return { items, problems };
}

/** Maps pack references to version ids. An unknown reference stays as written and fails the check. */
export function resolveRefs(
  items: BriefBullet[],
  resolve: (ref: string) => string | undefined,
): BriefBullet[] {
  return items.map((s) => ({ text: s.text, event_ids: s.event_ids.map((r) => resolve(r) ?? r) }));
}

/** Runs the rule 4 checker against the stored versions the sentences cite. */
export async function checkCited(db: Db, sentences: BriefBullet[]): Promise<CheckResult> {
  const ids = [...new Set(sentences.flatMap((s) => s.event_ids))];
  // Flight records never count as citations, so their ids stay unresolved.
  const events = (await getEvents(db, ids)).filter((e) => !isAircraftKind(e.kind));
  return checkSentences(sentences, new Map(events.map((e) => [e.id, e])));
}

/** The retry list, with every version id written back as the model's reference. */
export function retryProblems(
  unit: string,
  problems: string[],
  violations: CheckViolation[],
  refOf: ReadonlyMap<string, string>,
): string[] {
  const hide = (text: string) => {
    let out = text;
    for (const [id, ref] of refOf) out = out.split(id).join(ref);
    return out;
  };
  return [
    ...problems,
    ...violations.map((v) => hide(`${unit} ${v.sentenceIndex + 1}: ${v.detail}`)),
  ];
}

export async function generateBrief(
  db: Db,
  opts: GenerateBriefOptions,
): Promise<GenerateBriefResult> {
  const { now } = opts;
  const pack = await buildFactsPack(db, opts.windowEnd);
  if (!pack.items.length) {
    return { status: "empty", windowStart: pack.windowStart, windowEnd: pack.windowEnd };
  }

  const idOf = new Map(pack.items.map((item, i) => [item.id, pack.eventIds[i] ?? item.id]));
  const refOf = new Map([...idOf].map(([ref, id]) => [id, ref]));
  const base: ModelRequest = {
    system: BRIEF_SYSTEM_PROMPT,
    messages: [{ role: "user", content: briefUserMessage(pack.items) }],
    maxTokens: config.model.briefMaxTokens,
    outputSchema: briefOutputSchema(pack.items.map((item) => item.id)),
  };

  let charged = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  const messages: ModelMessage[] = [...base.messages];
  let bullets: BriefBullet[] = [];
  let check: BriefCheckResult = {
    ok: false,
    numbersChecked: 0,
    violations: [],
    problems: [],
    attempts: 0,
  };

  for (let attempt = 0; attempt <= config.brief.maxRetries; attempt++) {
    const out = await callModel({
      db,
      route: "brief",
      clientKey: charged ? null : opts.clientKey,
      request: { ...base, messages: [...messages] },
      client: opts.client,
      promptVersion: PROMPT_VERSION,
      now,
    });
    if (!out.cached) {
      charged = true;
      inputTokens += out.result.usage.inputTokens;
      outputTokens += out.result.usage.outputTokens;
      cost += out.costMicros;
    }

    const parsed = parseAnswer(out.result, "bullets");
    const problems = [...parsed.problems];
    if (parsed.items.length !== config.brief.bullets) {
      problems.push(
        `Write exactly ${config.brief.bullets} bullets; this answer has ${parsed.items.length}.`,
      );
    }
    bullets = resolveRefs(parsed.items, (ref) => idOf.get(ref));
    const result = await checkCited(db, bullets);
    check = {
      ok: problems.length === 0 && result.ok,
      numbersChecked: result.numbersChecked,
      violations: result.violations,
      problems,
      attempts: attempt + 1,
    };
    if (check.ok) break;

    messages.push(
      { role: "assistant", content: answerText(out.result) || "{}" },
      {
        role: "user",
        content: briefRetryMessage(retryProblems("Bullet", problems, result.violations, refOf)),
      },
    );
  }

  const brief: StoredBrief = {
    status: check.ok ? "published" : "failed",
    id: `brief-${now}-${pack.digest.slice(0, 12)}`,
    createdAt: now,
    windowStart: pack.windowStart,
    windowEnd: pack.windowEnd,
    inputDigest: pack.digest,
    model: config.model.id,
    bullets,
    checkResult: check,
    inputTokens,
    outputTokens,
    costMicros: cost,
  };
  await chargeWrites(db, 1, "system", now);
  await db.execute({
    sql: `INSERT OR IGNORE INTO briefs (id, created_at, window_start, window_end, input_digest, model, bullets,
            check_result, status, input_tokens, output_tokens, cost_micros)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      brief.id,
      brief.createdAt,
      brief.windowStart,
      brief.windowEnd,
      brief.inputDigest,
      brief.model,
      JSON.stringify(brief.bullets),
      JSON.stringify(brief.checkResult),
      brief.status,
      brief.inputTokens,
      brief.outputTokens,
      brief.costMicros,
    ],
  });
  return brief;
}

function parseBullets(text: string): BriefBullet[] {
  try {
    const list: unknown = JSON.parse(text);
    if (!Array.isArray(list)) return [];
    return list.flatMap((x: unknown) =>
      isObj(x) && typeof x.text === "string" && Array.isArray(x.event_ids)
        ? [
            {
              text: x.text,
              event_ids: x.event_ids.filter((id): id is string => typeof id === "string"),
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}

function numbersCheckedOf(checkResult: string): number {
  try {
    const parsed: unknown = JSON.parse(checkResult);
    const n = isObj(parsed) ? parsed.numbersChecked : undefined;
    return typeof n === "number" && Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** GET /api/brief: the newest published brief created in the retention window, as of `now`. */
export async function latestBriefPayload(db: Db, now: number): Promise<BriefPayload> {
  const since = now - config.retention.hours * MS_PER_HOUR;
  const rs = await db.execute({
    sql: `SELECT id, created_at, window_start, window_end, model, bullets, check_result FROM briefs
          WHERE status = 'published' AND created_at >= ? AND created_at <= ?
          ORDER BY created_at DESC LIMIT 1`,
    args: [since, now],
  });
  const row = rs.rows[0];
  if (row) {
    return {
      brief: {
        id: String(row.id),
        createdAt: Number(row.created_at),
        windowStart: Number(row.window_start),
        windowEnd: Number(row.window_end),
        model: String(row.model),
        bullets: parseBullets(String(row.bullets)),
        numbersChecked: numbersCheckedOf(String(row.check_result)),
      },
    };
  }
  const any = await db.execute({
    sql: "SELECT id FROM briefs WHERE created_at <= ? LIMIT 1",
    args: [now],
  });
  return {
    brief: null,
    reason: any.rows.length
      ? `No brief passed the number check in the last ${config.retention.hours} hours. Argus tries again every hour.`
      : "No brief yet. Argus writes one every hour once events arrive.",
  };
}
