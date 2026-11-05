// Builders for citable facts. The rule: code formats every number once, here or in the
// normalizer that owns it, and nothing downstream reformats it.
import type { Fact } from "./types.ts";

/** An upstream value copied exactly as the source wrote it (JSON number or CSV string). */
export function upstream(value: number | string, unit?: string): Fact {
  const text = typeof value === "number" ? String(value) : value.trim();
  const numeric = typeof value === "number" ? value : Number(text);
  return { value: Number.isFinite(numeric) ? numeric : text, text, ...(unit ? { unit } : {}) };
}

/** A value computed by Argus, shown with a fixed number of decimals. */
export function computed(value: number, decimals: number, unit?: string): Fact {
  return { value, text: value.toFixed(decimals), ...(unit ? { unit } : {}) };
}

/** An integer count computed by Argus. */
export function count(value: number, unit?: string): Fact {
  if (!Number.isInteger(value)) throw new Error(`count must be an integer, got ${value}`);
  return { value, text: String(value), ...(unit ? { unit } : {}) };
}

/** A plain string fact (place names, categories, dates as text). */
export function label(text: string): Fact {
  return { value: text, text };
}

/** Clock time in UTC as "HH:MM UTC". */
export function utcTime(ms: number): Fact {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return { value: ms, text: `${hh}:${mm} UTC` };
}

/** Calendar date in UTC as "YYYY-MM-DD". */
export function utcDate(ms: number): Fact {
  return { value: ms, text: new Date(ms).toISOString().slice(0, 10) };
}
