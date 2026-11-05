/**
 * Rule 4: every number in a brief appears in the events it cites (docs/plan.md section 3d). Runs
 * inline before a brief or an Ask answer is published, and in scripts/check-briefs.ts.
 *
 * For each sentence, in this order:
 * 1. It cites at least one id (no_citation), and every cited id is in `events` (unresolved_id).
 * 2. The tokenizer in tokens.ts reports non-ASCII digits (non_ascii_digit), event ids in the text
 *    (id_in_text), and number words and multipliers (number_word).
 * 3. Every number token equals a number token from the cited events' `facts.*.text`
 *    (number_not_in_facts), and every alnum token equals, ignoring case, an alnum token from
 *    those facts (alnum_not_in_facts). Only cited events count; `raw` and `meta` never do.
 * 4. Copy rules from copy-rules.ts: dashes (dash) and banned words (banned_word).
 * 5. The first letter or digit of the sentence is an uppercase letter or a digit
 *    (not_capitalized). A leading digit passes: there is nothing to capitalize.
 *
 * Violations repeat per sentence only once per (kind, token). `numbersChecked` counts every
 * number and alnum token compared against facts, repeats included.
 */
import type { EventRecord } from "../events/types.ts";
import { copyViolations } from "./copy-rules.ts";
import { citableTokens, normalizeText, scanText } from "./tokens.ts";

export interface Sentence {
  text: string;
  event_ids: string[];
}

export type CheckViolationKind =
  | "unresolved_id"
  | "no_citation"
  | "number_not_in_facts"
  | "alnum_not_in_facts"
  | "number_word"
  | "non_ascii_digit"
  | "dash"
  | "banned_word"
  | "id_in_text"
  | "not_capitalized";

export interface CheckViolation {
  kind: CheckViolationKind;
  sentenceIndex: number;
  token?: string;
  detail: string;
}

export interface CheckResult {
  ok: boolean;
  violations: CheckViolation[];
  numbersChecked: number;
}

function codePoint(ch: string): string {
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Why the sentence start fails sentence case, or null when it passes. */
function capitalizationProblem(text: string): { token?: string; detail: string } | null {
  const first = /[\p{L}\p{N}]/u.exec(normalizeText(text))?.[0];
  if (first === undefined) return { detail: "Sentence has no letters or digits" };
  if (/[\p{N}\p{Lu}\p{Lt}]/u.test(first)) return null;
  return { token: first, detail: `Sentence starts with "${first}", not an uppercase letter` };
}

export function checkSentences(
  sentences: Sentence[],
  events: Map<string, EventRecord>,
): CheckResult {
  const violations: CheckViolation[] = [];
  let numbersChecked = 0;

  sentences.forEach((sentence, sentenceIndex) => {
    const seen = new Set<string>();
    const add = (kind: CheckViolationKind, detail: string, token?: string) => {
      const key = `${kind}\u0000${token ?? ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      violations.push({ kind, sentenceIndex, ...(token === undefined ? {} : { token }), detail });
    };

    const ids = [...new Set(Array.isArray(sentence.event_ids) ? sentence.event_ids : [])];
    if (!ids.length) add("no_citation", "Sentence cites no event");
    const cited: EventRecord[] = [];
    for (const id of ids) {
      const event = events.get(id);
      if (event) cited.push(event);
      else add("unresolved_id", `Cited id ${id} does not resolve to a stored event`, id);
    }
    const allowed = citableTokens(cited);

    const text = typeof sentence.text === "string" ? sentence.text : "";
    const scan = scanText(text);
    for (const ch of scan.nonAsciiDigits) {
      add("non_ascii_digit", `Non-ASCII digit ${codePoint(ch)}; use ASCII 0-9`, ch);
    }
    for (const id of scan.eventIds) add("id_in_text", `Event id ${id} is in the text`, id);
    for (const word of scan.numberWords) {
      add("number_word", `Number word "${word}"; copy digits from the cited facts`, word);
    }
    for (const n of scan.numbers) {
      numbersChecked++;
      if (!allowed.numbers.has(n)) add("number_not_in_facts", `${n} is not in the cited facts`, n);
    }
    for (const a of scan.alnum) {
      numbersChecked++;
      if (!allowed.alnum.has(a)) add("alnum_not_in_facts", `${a} is not in the cited facts`, a);
    }
    for (const v of copyViolations(text)) add(v.kind, v.detail, v.token);
    const cap = capitalizationProblem(text);
    if (cap) add("not_capitalized", cap.detail, cap.token);
  });

  return { ok: violations.length === 0, violations, numbersChecked };
}
