/**
 * The rule 4 tokenizer (docs/plan.md section 3d). One grammar runs on brief sentences and on the
 * cited events' `facts.*.text`, so a sentence number passes only when a cited fact yields the
 * identical token. `raw` and `meta` are never read. tests/fixtures/check/golden.json pins it.
 *
 * Grammar, applied in this order:
 *
 * 1. Non-ASCII numbers. Every Unicode number character (\p{N}: Nd, Nl, No) other than ASCII 0-9
 *    is reported and replaced by a space before normalization, because NFKC would turn a
 *    fullwidth "\uFF14" or a superscript "\u00B2" into an ASCII digit and hide it. Arabic-Indic "\u0664",
 *    fullwidth "\uFF14", superscript "\u00B2", circled "\u2460", and fractions such as "\u00BD" are all reported.
 * 2. Normalization (normalizeText): NFKC, then format characters (\p{Cf}: soft hyphen, zero-width
 *    space, bidi controls) are removed, then U+2010 hyphen and U+2212 minus sign become "-".
 *    Step 1 runs again on the result.
 * 3. Event ids (EVENT_ID_PATTERN, src/lib/ids.ts) are reported and replaced by a space, so the
 *    digits inside an id are never tokens, in sentences or in facts.
 * 4. Chunks. A chunk is a run of letters, marks, and ASCII digits, joined by "-" between two such
 *    characters, or by ".", ",", or ":" between two ASCII digits. A chunk with no digit is a word,
 *    not a token. "%" and every other character separate chunks, so a trailing "%" is dropped.
 * 5. Alnum tokens. A chunk with a letter and a digit is one alnum token, compared lowercased:
 *    "NOAA-20" gives "noaa-20"; "ci41234567", "25-km", "M-4.6", and "22nd" are alnum tokens too.
 *    Hyphens stay inside the word. The one exception is the magnitude form: "M" followed by a
 *    number ("M4.6") gives the number token "4.6". "M 4.6" needs no exception: "M" is a word and
 *    "4.6" a number.
 * 6. Number tokens. A chunk of digits and joiners only:
 *    - an ISO date ("2026-09-22") is one token;
 *    - anything else splits at "-" ("3-5" gives "3" and "5"). Each part is one token: a clock time
 *      ("21:55") stays whole, and thousands separators are removed when every group after the
 *      first has exactly 3 digits ("12,345.6" gives "12345.6"; "1,23" stays "1,23").
 *    A "-" (and a "." before a digit) directly in front of a chunk belongs to its first token
 *    when the character before it is not a letter, mark, or digit: "depth -1.2" gives "-1.2" and
 *    " .5" gives ".5", while "3-5" is a range. Tokens compare as exact strings, so "4.6" never
 *    equals "4.63" or "4.60".
 * 7. Number words. Whole words (letter runs that do not touch a digit) found in NUMBER_WORDS, plus
 *    any word ending in "fold": "tenfold", or "fold" right after a hyphen as in "10-fold".
 */
import type { EventRecord } from "../events/types.ts";
import { EVENT_ID_PATTERN } from "../lib/ids.ts";

export interface Tokens {
  /** Number tokens, normalized (thousands separators removed, sign kept). */
  numbers: string[];
  /** Words that mix letters and digits, lowercased. */
  alnum: string[];
}

export interface CitableTokens {
  numbers: Set<string>;
  alnum: Set<string>;
}

/** Everything the checker needs from one text. */
export interface TextScan extends Tokens {
  /** Unicode number characters other than ASCII 0-9, as written. */
  nonAsciiDigits: string[];
  /** Event ids found in the text. */
  eventIds: string[];
  /** Number words and multipliers, as written. */
  numberWords: string[];
}

/**
 * Spelled-out numbers and multipliers (plan 3d rule 4: English cardinals and ordinals from zero
 * upward, plus multipliers). Words ending in "fold" are matched by rule, not listed.
 */
export const NUMBER_WORDS: ReadonlySet<string> = new Set([
  // cardinals
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
  "million",
  "billion",
  "trillion",
  "tens",
  "hundreds",
  "thousands",
  "millions",
  "billions",
  "trillions",
  "dozen",
  "dozens",
  // ordinals
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
  "fourteenth",
  "fifteenth",
  "sixteenth",
  "seventeenth",
  "eighteenth",
  "nineteenth",
  "twentieth",
  "thirtieth",
  "fortieth",
  "fiftieth",
  "sixtieth",
  "seventieth",
  "eightieth",
  "ninetieth",
  "hundredth",
  "thousandth",
  "millionth",
  "billionth",
  // multipliers and fractions
  "double",
  "doubles",
  "doubled",
  "doubling",
  "twice",
  "triple",
  "triples",
  "tripled",
  "tripling",
  "thrice",
  "quadruple",
  "quadrupled",
  "quadrupling",
  "half",
  "halves",
  "halved",
  "halving",
  "pair",
  "pairs",
]);

const NON_ASCII_NUMBER = /(?![0-9])\p{N}/gu;
const CHUNK_CHAR = String.raw`[\p{L}\p{M}0-9]`;
// Groups: 1 sign, 2 leading decimal point, 3 chunk.
const TOKEN_RE = new RegExp(
  String.raw`(?<!${CHUNK_CHAR})(-)?(\.(?=[0-9]))?(${CHUNK_CHAR}+(?:(?:-|(?<=[0-9])[.,:](?=[0-9]))${CHUNK_CHAR}+)*)`,
  "gu",
);
const WORD_RE = /[\p{L}\p{M}]+/gu;
const HAS_DIGIT = /[0-9]/;
const HAS_LETTER = /[\p{L}\p{M}]/u;
const MAGNITUDE = /^M([0-9]+(?:\.[0-9]+)?)$/;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const GROUPED = /^-?[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?$/;

/** NFKC, format characters removed, U+2010 hyphen and U+2212 minus sign as "-". */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\u2010\u2212]/g, "-");
}

function normalizeNumber(token: string): string {
  return GROUPED.test(token) ? token.replaceAll(",", "") : token;
}

/** Runs the whole grammar on one text. */
export function scanText(text: string): TextScan {
  const nonAsciiDigits: string[] = [];
  const eventIds: string[] = [];
  const numberWords: string[] = [];
  const numbers: string[] = [];
  const alnum: string[] = [];

  const blankNonAscii = (s: string) =>
    s.replace(NON_ASCII_NUMBER, (ch) => {
      nonAsciiDigits.push(ch);
      return " ";
    });
  const idPattern = new RegExp(EVENT_ID_PATTERN.source, EVENT_ID_PATTERN.flags);
  const work = blankNonAscii(normalizeText(blankNonAscii(text))).replace(idPattern, (id) => {
    eventIds.push(id);
    return " ";
  });

  for (const m of work.matchAll(TOKEN_RE)) {
    const sign = m[1] ?? "";
    const lead = m[2] ?? "";
    const chunk = m[3] ?? "";
    if (!HAS_DIGIT.test(chunk)) continue;
    if (HAS_LETTER.test(chunk)) {
      const magnitude = MAGNITUDE.exec(chunk)?.[1];
      if (magnitude !== undefined) numbers.push(magnitude);
      else alnum.push(chunk.toLowerCase());
      continue;
    }
    if (ISO_DATE.test(chunk)) {
      numbers.push(sign + lead + chunk);
      continue;
    }
    chunk.split("-").forEach((part, i) => {
      numbers.push(normalizeNumber(i === 0 ? sign + lead + part : part));
    });
  }

  for (const m of work.matchAll(WORD_RE)) {
    const word = m[0];
    const at = m.index ?? 0;
    const before = work[at - 1] ?? "";
    const after = work[at + word.length] ?? "";
    if (HAS_DIGIT.test(before) || HAS_DIGIT.test(after)) continue;
    const lower = word.toLowerCase();
    const fold = lower.endsWith("fold") && (lower.length > 4 || before === "-");
    if (NUMBER_WORDS.has(lower) || fold) numberWords.push(word);
  }

  return { numbers, alnum, nonAsciiDigits, eventIds, numberWords };
}

/** The number and alnum tokens of one text. */
export function extractTokens(text: string): Tokens {
  const { numbers, alnum } = scanText(text);
  return { numbers, alnum };
}

/** Every token a sentence citing these events may use, built only from `facts.*.text`. */
export function citableTokens(events: Iterable<EventRecord>): CitableTokens {
  const numbers = new Set<string>();
  const alnum = new Set<string>();
  for (const event of events) {
    for (const fact of Object.values(event.facts)) {
      if (typeof fact?.text !== "string") continue;
      const tokens = extractTokens(fact.text);
      for (const n of tokens.numbers) numbers.add(n);
      for (const a of tokens.alnum) alnum.add(a);
    }
  }
  return { numbers, alnum };
}
