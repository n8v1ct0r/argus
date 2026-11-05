// DEMO mode for the brief and Ask Argus when no model key exists (the static deploy). Code picks
// the events with the same facts pack the model would see, and fills fixed sentence templates with
// fact text copied verbatim. The output passes the same rule 4 checker as a model brief: every
// number in a sentence is copied from a fact of an event it cites.
import { config } from "../../argus.config.ts";
import type { BriefBullet } from "../api/types.ts";
import type { EventRecord } from "../events/types.ts";
import { detectorOf } from "./facts.ts";

/** The model field of a template brief; the UI labels it DEMO. */
export const TEMPLATE_MODEL = "demo-template";

function fact(e: EventRecord, key: string): string | null {
  const text = e.facts[key]?.text;
  return typeof text === "string" && text.trim() !== "" ? text.trim() : null;
}

/** One sentence about one stored event, or null when its facts cannot fill a template. */
export function templateSentence(e: EventRecord): string | null {
  const detector = detectorOf(e);
  if (detector === "quake_cluster") {
    const n = fact(e, "count");
    const km = fact(e, "max_distance_km");
    const place = fact(e, "place");
    const mag = fact(e, "max_mag");
    const first = fact(e, "first_time");
    const last = fact(e, "last_time");
    if (!n || !km || !first || !last) return null;
    return [
      `Argus found ${n} quakes within ${km} km of each other`,
      place ? ` near ${place}` : "",
      `, from ${first} to ${last}.`,
      mag ? ` The strongest was magnitude ${mag}.` : "",
    ].join("");
  }
  if (detector === "fire_growth") {
    const c0 = fact(e, "count_day0");
    const c1 = fact(e, "count_day1");
    const pct = fact(e, "growth_pct");
    const d0 = fact(e, "date_day0");
    const d1 = fact(e, "date_day1");
    if (!c0 || !c1 || !pct || !d0 || !d1) return null;
    return `Heat detections in a grid cell rose from ${c0} on ${d0} to ${c1} on ${d1}, up ${pct}.`;
  }
  if (detector === "circling") {
    const turn = fact(e, "total_turn_deg");
    const dir = fact(e, "direction");
    const area = fact(e, "area");
    const start = fact(e, "start_time");
    const end = fact(e, "end_time");
    if (!turn || !dir || !start || !end) return null;
    return `An aircraft turned ${turn} degrees to the ${dir}${area ? ` near ${area}` : ""} between ${start} and ${end}.`;
  }
  if (e.kind === "earthquake") {
    const mag = fact(e, "mag");
    const place = fact(e, "place");
    const time = fact(e, "time");
    const date = fact(e, "date");
    const depth = fact(e, "depth_km");
    if (!mag || !time || !date) return null;
    return [
      `Magnitude ${mag} quake`,
      place ? `, ${place}` : "",
      `. It struck at ${time} on ${date}`,
      depth ? `, ${depth} km deep.` : ".",
    ].join("");
  }
  if (e.kind === "aggregate") {
    const n = fact(e, "count");
    const kinds = fact(e, "kinds");
    const min = fact(e, "min_magnitude");
    const fd = fact(e, "from_date");
    const ft = fact(e, "from_time");
    const td = fact(e, "to_date");
    const tt = fact(e, "to_time");
    if (!n || !fd || !ft || !td || !tt) return null;
    const what =
      kinds === "earthquake"
        ? `USGS reported ${n} quakes${min ? ` of magnitude ${min} or more` : ""}`
        : `Argus counted ${n} stored events`;
    return `${what} between ${ft} on ${fd} and ${tt} on ${td}.`;
  }
  if (e.kind === "natural_event") {
    const title = fact(e, "title");
    const category = fact(e, "category");
    const date = fact(e, "date");
    if (!title) return null;
    return `NASA EONET lists ${title}${category ? ` (${category.toLowerCase()})` : ""}${date ? `, dated ${date}` : ""}.`;
  }
  return null;
}

/**
 * The template brief: the first `config.brief.bullets` events of the facts pack that fill a
 * template, each bullet citing exactly the event it describes.
 */
export function templateBullets(events: readonly EventRecord[]): BriefBullet[] {
  const out: BriefBullet[] = [];
  for (const e of events) {
    if (out.length >= config.brief.bullets) break;
    const text = templateSentence(e);
    if (text) out.push({ text: capitalize(text), event_ids: [e.id] });
  }
  return out;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A preset Ask Argus question and the code that answers it from stored events. */
export interface TemplateQuestion {
  question: string;
  pick: (events: readonly EventRecord[]) => EventRecord[];
}

function magOf(e: EventRecord): number {
  const v = e.facts.mag?.value;
  return typeof v === "number" ? v : Number.NEGATIVE_INFINITY;
}

/** The count the static deploy leads with: quakes at or above this magnitude in the window. */
export const COUNT_MIN_MAGNITUDE = 4.5;

export const TEMPLATE_QUESTIONS: readonly TemplateQuestion[] = [
  {
    question: `How many quakes reached magnitude ${COUNT_MIN_MAGNITUDE}?`,
    pick: (events) => events.filter((e) => e.kind === "aggregate").slice(0, 1),
  },
  {
    question: "Which quakes were strongest?",
    pick: (events) =>
      events
        .filter((e) => e.kind === "earthquake")
        .sort((a, b) => magOf(b) - magOf(a) || b.occurredAt - a.occurredAt)
        .slice(0, 3),
  },
  {
    question: "Did quakes cluster anywhere?",
    pick: (events) => events.filter((e) => detectorOf(e) === "quake_cluster").slice(0, 3),
  },
  {
    question: "Did any aircraft circle?",
    pick: (events) => events.filter((e) => detectorOf(e) === "circling").slice(0, 3),
  },
  {
    question: "Which natural events are listed?",
    pick: (events) => events.filter((e) => e.kind === "natural_event").slice(0, 3),
  },
];

/** Template sentences for a preset question, one per picked event. */
export function templateAnswer(q: TemplateQuestion, events: readonly EventRecord[]): BriefBullet[] {
  return q.pick(events).flatMap((e) => {
    const text = templateSentence(e);
    return text ? [{ text: capitalize(text), event_ids: [e.id] }] : [];
  });
}
