// Copy rules (CLAUDE.md, "Copy rules"): no em or en dashes and none of the banned words. Shared by
// the brief checker and scripts/check-copy.ts. Pure functions: text in, violations out.
import { normalizeText } from "./tokens.ts";

/** The banned words. Each one also covers its inflections (BANNED_FORMS). */
export const BANNED_WORDS = [
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
] as const;

export type BannedWord = (typeof BANNED_WORDS)[number];

/** Whole-word patterns, matched case-insensitively after normalizeText(). */
const BANNED_FORMS: Record<BannedWord, string> = {
  leverage: String.raw`leverag(?:e|es|ed|ing)`,
  delve: String.raw`delv(?:e\p{L}*|ing)`,
  landscape: String.raw`landscapes?`,
  showcase: String.raw`showcas(?:e\p{L}*|ing)`,
  pivotal: String.raw`pivotal(?:ly)?`,
  seamless: String.raw`seamless(?:ly|ness)?`,
  robust: String.raw`robust(?:ly|ness)?`,
  empower: String.raw`empower\p{L}*`,
  unlock: String.raw`unlock\p{L}*`,
  transform: String.raw`transform\p{L}*`,
};

const WORD_EDGE_BEFORE = String.raw`(?<![\p{L}\p{M}\p{N}])`;
const WORD_EDGE_AFTER = String.raw`(?![\p{L}\p{M}\p{N}])`;
const BANNED_RE = new RegExp(
  `${WORD_EDGE_BEFORE}(?:${BANNED_WORDS.map((w) => BANNED_FORMS[w]).join("|")})${WORD_EDGE_AFTER}`,
  "giu",
);

/** Dashes that are not allowed. NFKC folds the small and vertical forms into these. */
const DASH_NAMES: Record<string, string> = {
  "\u2012": "Figure dash",
  "\u2013": "En dash",
  "\u2014": "Em dash",
  "\u2015": "Horizontal bar",
  "\u2E3A": "Two-em dash",
  "\u2E3B": "Three-em dash",
};
const DASH_RE = /[\u2012-\u2015\u2E3A\u2E3B]/gu;

export interface CopyViolation {
  kind: "dash" | "banned_word";
  /** The offending character or word, as it reads after normalizeText(). */
  token: string;
  detail: string;
}

function codePoint(ch: string): string {
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Every dash and banned word in the text, in that order, one entry per occurrence. */
export function copyViolations(text: string): CopyViolation[] {
  const normalized = normalizeText(text);
  const out: CopyViolation[] = [];
  for (const m of normalized.matchAll(DASH_RE)) {
    const ch = m[0];
    out.push({
      kind: "dash",
      token: ch,
      detail: `${DASH_NAMES[ch] ?? "Dash"} (${codePoint(ch)}) is not allowed`,
    });
  }
  for (const m of normalized.matchAll(BANNED_RE)) {
    out.push({ kind: "banned_word", token: m[0], detail: `"${m[0]}" is a banned word` });
  }
  return out;
}
