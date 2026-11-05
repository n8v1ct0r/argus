// Query parameter parsing for the read API. Every parser returns a value or a plain-words error
// that the route sends back with status 400. Pure: no clock, no database.
import { MS_PER_DAY } from "../../lib/time.ts";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** The window a route uses when the request names none: the last 24 hours. */
export const DEFAULT_WINDOW_MS = MS_PER_DAY;
/** The longest window a route answers, so one request cannot scan the whole store. */
export const MAX_WINDOW_DAYS = 7;
export const MAX_WINDOW_MS = MAX_WINDOW_DAYS * MS_PER_DAY;
/** At most this many ids per /api/events request. */
export const MAX_IDS = 50;
/** An event id: a lowercase source, a colon, then 1 to 200 characters without whitespace. */
export const EVENT_ID_RE = /^[a-z]+:[^\s]{1,200}$/;

/** Epoch milliseconds, optionally with a fraction (floored). Larger than any valid Date fails. */
const MS_RE = /^\d{1,16}(?:\.\d+)?$/;
const MAX_DATE_MS = 8.64e15;
const QUOTE_MAX = 60;

export interface Window {
  from: number;
  to: number;
}

function fail<T>(error: string): Parsed<T> {
  return { ok: false, error };
}

function quote(text: string): string {
  return text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX)}...` : text;
}

/** One optional time parameter in epoch milliseconds. */
export function parseTime(raw: string | null, name: string): Parsed<number | null> {
  if (raw === null) return { ok: true, value: null };
  const text = raw.trim();
  const value = Math.floor(Number(text));
  if (!MS_RE.test(text) || !Number.isFinite(value) || value > MAX_DATE_MS) {
    return fail(
      `The ${name} parameter must be a time in epoch milliseconds, for example ${name}=1790200000000.`,
    );
  }
  return { ok: true, value };
}

/**
 * from and to in epoch milliseconds. Both are optional: to defaults to now and from to 24 hours
 * before to. from must come before to, and the window may span at most 7 days.
 */
export function parseWindow(sp: URLSearchParams, now: number): Parsed<Window> {
  const to = parseTime(sp.get("to"), "to");
  if (!to.ok) return to;
  const from = parseTime(sp.get("from"), "from");
  if (!from.ok) return from;
  const end = to.value ?? now;
  const start = from.value ?? end - DEFAULT_WINDOW_MS;
  if (start >= end) {
    return fail("The from time must be earlier than the to time. Swap them or widen the window.");
  }
  if (end - start > MAX_WINDOW_MS) {
    return fail(`The window can span at most ${MAX_WINDOW_DAYS} days. Ask for a shorter range.`);
  }
  return { ok: true, value: { from: start, to: end } };
}

/** The at parameter in epoch milliseconds; defaults to now. */
export function parseAt(sp: URLSearchParams, now: number): Parsed<number> {
  const at = parseTime(sp.get("at"), "at");
  if (!at.ok) return at;
  return { ok: true, value: at.value ?? now };
}

/** wildfires=1 includes EONET wildfires, wildfires=0 or no value leaves them out. */
export function parseWildfires(sp: URLSearchParams): Parsed<boolean> {
  const raw = sp.get("wildfires");
  if (raw === null || raw === "0") return { ok: true, value: false };
  if (raw === "1") return { ok: true, value: true };
  return fail("The wildfires parameter must be 1 to include wildfires or 0 to leave them out.");
}

/** Splits a comma-separated id list. No event id holds a comma (fire cells are spelled 34_-119). */
export function splitIds(raw: string): string[] {
  return raw.split(",").filter((piece) => piece !== "");
}

/** ids=a,b: 1 to 50 event ids, duplicates dropped, request order kept. */
export function parseIds(sp: URLSearchParams): Parsed<string[]> {
  const raw = sp.get("ids");
  const ids = raw === null ? [] : splitIds(raw.trim());
  if (!ids.length) {
    return fail("Name at least one event id, for example ids=usgs:us7000abcd@1790200000000.");
  }
  if (ids.length > MAX_IDS) {
    return fail(
      `Ask for at most ${MAX_IDS} event ids at a time. Split the list into smaller requests.`,
    );
  }
  for (const id of ids) {
    if (!EVENT_ID_RE.test(id)) {
      return fail(
        `This is not an event id: "${quote(id)}". Event ids look like usgs:us7000abcd@1790200000000.`,
      );
    }
  }
  return { ok: true, value: [...new Set(ids)] };
}
