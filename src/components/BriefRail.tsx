"use client";
// The brief as an alert feed, Ask Argus answers, and the citations sheet: the sentence with its
// numbers linked to the facts they came from, and one record block per cited event.
import { useMemo, useState } from "react";
import type {
  AskResponse,
  BriefBullet,
  BriefPayload,
  CitationEvent,
  EventsPayload,
  ReplaySummary,
} from "../api/types.ts";
import { extractTokens } from "../check/tokens.ts";
import { AreaSpark, binCounts } from "./Charts.tsx";
import { CloseIcon } from "./icons.tsx";
import { utcClock } from "./ReplayStrip.tsx";
import { useWidth } from "./useWidth.ts";

export type Selection =
  { from: "brief" | "ask"; index: number } | { from: "pick"; ids: string[] } | null;

/** Splits a sentence into plain runs and number runs that match a cited fact. */
function numberRuns(
  text: string,
  factsByToken: Map<string, Array<{ eventId: string; key: string }>>,
) {
  const tokens = new Set(extractTokens(text).numbers);
  const runs: Array<{ text: string; links?: Array<{ eventId: string; key: string }> }> = [];
  const re = /-?\d[\d,]*(?:\.\d+)?(?::\d{2})?/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const raw = m[0];
    const norm = raw.replace(/(\d),(?=\d{3}\b)/g, "$1");
    const links = tokens.has(norm) ? factsByToken.get(norm) : undefined;
    if (m.index === undefined) continue;
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    runs.push(links ? { text: raw, links } : { text: raw });
    last = m.index + raw.length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs;
}

function factIndex(events: CitationEvent[]) {
  const map = new Map<string, Array<{ eventId: string; key: string }>>();
  for (const e of events) {
    for (const [key, fact] of Object.entries(e.facts)) {
      for (const tok of extractTokens(fact.text).numbers) {
        const list = map.get(tok) ?? [];
        list.push({ eventId: e.id, key });
        map.set(tok, list);
      }
    }
  }
  return map;
}

function Sentence({
  sentence,
  factsByToken,
  onHover,
}: {
  sentence: BriefBullet;
  factsByToken: Map<string, Array<{ eventId: string; key: string }>> | null;
  onHover?: (links: Array<{ eventId: string; key: string }> | null) => void;
}) {
  if (!factsByToken) return <>{sentence.text}</>;
  return (
    <>
      {numberRuns(sentence.text, factsByToken).map((r, i) =>
        r.links ? (
          <span
            key={i}
            tabIndex={0}
            onMouseEnter={() => onHover?.(r.links ?? null)}
            onMouseLeave={() => onHover?.(null)}
            onFocus={() => onHover?.(r.links ?? null)}
            onBlur={() => onHover?.(null)}
            className="cursor-help rounded-[3px] border-b border-dashed border-pen px-px text-pen outline-none focus-visible:bg-pen/20"
          >
            {r.text}
          </span>
        ) : (
          <span key={i}>{r.text}</span>
        ),
      )}
    </>
  );
}

/** What kind of evidence a sentence cites, as a short chip. */
export function kindChip(kind: string | undefined): { label: string; accent: boolean } {
  if (kind === "detection") return { label: "FINDING", accent: true };
  if (kind === "aggregate") return { label: "COUNT", accent: false };
  if (kind === "earthquake") return { label: "QUAKE", accent: false };
  if (kind === "natural_event") return { label: "EVENT", accent: false };
  if (kind === "fire_cell_day") return { label: "FIRE", accent: false };
  return { label: "RECORD", accent: false };
}

export function Chip({ label, accent }: { label: string; accent?: boolean }) {
  return (
    <span
      className={`inline-flex h-[18px] shrink-0 items-center rounded-[5px] border px-1.5 font-mono text-[10px] leading-none tracking-[0.06em] ${
        accent ? "border-pen/60 bg-pen/15 text-pen" : "border-white/15 text-graphite"
      }`}
    >
      {label}
    </span>
  );
}

function StationHeader({ event, lit }: { event: CitationEvent; lit: Set<string> }) {
  return (
    <article
      className="mx-3 mb-3 rounded-[12px] border border-white/[0.06] bg-black/25 px-3.5 py-3"
      aria-label={event.title}
    >
      <div className="flex items-center gap-2">
        <Chip {...kindChip(event.kind)} />
        <p className="truncate text-caption text-graphite">{event.credit}</p>
      </div>
      <h4 className="mt-1.5 text-body font-semibold">{event.title}</h4>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-caption">
        <dt className="text-graphite">Event</dt>
        <dd className="break-all">{event.id}</dd>
        <dt className="text-graphite">Occurred</dt>
        <dd>{utcClock(event.occurredAt)}</dd>
        <dt className="text-graphite">Fetched</dt>
        <dd>{utcClock(event.fetchedAt)}</dd>
        <dt className="text-graphite">Digest</dt>
        <dd title={event.rawDigest}>
          {event.rawDigest.slice(0, 8)}…{event.rawDigest.slice(-4)}
        </dd>
      </dl>
      <table className="mt-3 w-full border-collapse text-small">
        <caption className="sr-only">Facts the brief may cite</caption>
        <tbody>
          {Object.entries(event.facts).map(([key, fact]) => {
            const on = lit.has(`${event.id}|${key}`);
            return (
              <tr key={key} className={on ? "bg-pen/20" : ""}>
                <th scope="row" className="py-0.5 pr-3 text-left font-normal text-graphite">
                  {key.replaceAll("_", " ")}
                </th>
                <td className={`py-0.5 font-mono ${on ? "text-scratch" : ""}`}>
                  {fact.text}
                  {fact.unit && fact.unit !== "" && !fact.text.endsWith(fact.unit)
                    ? ` ${fact.unit}`
                    : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {event.members.length > 0 && (
        <p className="mt-2 text-caption text-graphite">
          Built from {event.members.length} stored {event.members.length === 1 ? "event" : "events"}
          .
        </p>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer text-caption text-graphite hover:text-scratch">
          Stored record
        </summary>
        <pre className="mt-1 max-h-60 overflow-auto rounded-[8px] border border-hair bg-black/30 p-2 font-mono text-[11px] leading-4 break-all whitespace-pre-wrap text-scratch">
          {event.record}
        </pre>
        {event.recordNote && <p className="mt-1 text-caption text-graphite">{event.recordNote}</p>}
      </details>
    </article>
  );
}

export interface CitationSheetProps {
  selection: Exclude<Selection, null>;
  sentence: BriefBullet | null;
  citations: EventsPayload | null;
  citationsLoading: boolean;
  citationsError: string | null;
  onClose: () => void;
}

/** The proof for one sentence (or one picked point): every cited event's stored record. */
export function CitationSheet(p: CitationSheetProps) {
  const [lit, setLit] = useState<Set<string>>(new Set());
  const factsByToken = useMemo(
    () => (p.citations ? factIndex(p.citations.events) : null),
    [p.citations],
  );
  const pick = p.selection.from === "pick";
  return (
    <section aria-labelledby="citations-title" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-1">
        <h2 id="citations-title" className="text-title font-semibold">
          {pick ? "Selected on the globe" : "Citations"}
        </h2>
        {p.citations && (
          <span className="font-mono text-caption text-graphite">
            {p.citations.events.length} {p.citations.events.length === 1 ? "record" : "records"}
          </span>
        )}
        <button
          type="button"
          onClick={p.onClose}
          aria-label={
            p.selection.from === "ask" ? "Close and go back to Ask Argus" : "Close the citations"
          }
          className="ml-auto flex size-7 items-center justify-center rounded-full text-graphite hover:bg-white/10 hover:text-scratch"
        >
          <CloseIcon />
        </button>
      </div>
      {p.sentence && !pick ? (
        <p className="px-4 pt-1 pb-3 text-reading">
          <span className="mr-2 font-mono text-pen">
            {p.selection.from === "brief" ? p.selection.index + 1 : "A"}
          </span>
          <Sentence
            sentence={p.sentence}
            factsByToken={factsByToken}
            onHover={(links) => setLit(new Set((links ?? []).map((l) => `${l.eventId}|${l.key}`)))}
          />
        </p>
      ) : (
        <p className="px-4 pt-1 pb-3 text-small text-graphite">
          The stored record behind this point.
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
        {p.citationsLoading && (
          <p className="px-4 py-3 text-small text-graphite">Loading the cited events</p>
        )}
        {p.citationsError && (
          <p role="alert" className="px-4 py-3 text-small text-varnish">
            The cited events could not be loaded: {p.citationsError}
          </p>
        )}
        {p.citations?.missing.length ? (
          <p role="alert" className="px-4 py-3 text-small text-varnish">
            {p.citations.missing.length} cited{" "}
            {p.citations.missing.length === 1 ? "event is" : "events are"} no longer stored.
          </p>
        ) : null}
        {p.citations?.events.map((ev) => (
          <StationHeader key={ev.id} event={ev} lit={lit} />
        ))}
      </div>
    </section>
  );
}

export interface FeedPanelProps {
  brief: BriefPayload | null;
  briefLoading: boolean;
  briefError: string | null;
  /** The stored events the brief cites, for each row's kind chip. */
  eventsById: Map<string, CitationEvent>;
  replay: ReplaySummary | null;
  from: number | null;
  to: number | null;
  t: number;
  mode: "brief" | "ask";
  onMode: (m: "brief" | "ask") => void;
  ask: AskResponse | null;
  askPending: boolean;
  onAsk: (question: string) => void;
  /** Static deploy: the preset questions with recorded template answers; null on a live store. */
  presets: string[] | null;
  selection: Selection;
  onSelect: (s: Selection) => void;
}

const HOUR = 3_600_000;

/** The brief as an alert feed: time, kind, the sentence, and how many events it cites. */
export function FeedPanel(p: FeedPanelProps) {
  const [chartRef, chartW] = useWidth<HTMLDivElement>();
  const brief = p.brief?.brief;
  const perHour = useMemo(
    () =>
      p.replay && p.from !== null && p.to !== null
        ? binCounts(
            p.replay.quakes.map((q) => q.t),
            p.from,
            p.to,
            HOUR,
          )
        : null,
    [p.replay, p.from, p.to],
  );
  const activeIndex =
    p.selection && p.selection.from !== "pick" && p.selection.from === p.mode
      ? p.selection.index
      : null;

  return (
    <section aria-labelledby="brief-title" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 pt-3.5">
        <h2 id="brief-title" className="text-title font-semibold">
          Brief
        </h2>
        {brief?.model === "demo-template" && <Chip label="DEMO" />}
        <div
          role="group"
          aria-label="Feed"
          className="ml-auto flex rounded-[9px] bg-black/30 p-0.5 text-caption"
        >
          {(["brief", "ask"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={p.mode === m}
              onClick={() => p.onMode(m)}
              className={`rounded-[7px] px-2.5 py-1 ${
                p.mode === m
                  ? "bg-white/[0.14] text-scratch shadow-[inset_0_1px_0_rgb(255_255_255/0.1)]"
                  : "text-graphite hover:text-scratch"
              }`}
            >
              {m === "brief" ? "Sentences" : "Ask Argus"}
            </button>
          ))}
        </div>
      </div>

      {p.mode === "brief" ? (
        <>
          <div className="mx-4 mt-2 flex items-center gap-2 text-micro text-graphite">
            <span className="font-mono">
              {brief
                ? `${utcClock(brief.windowEnd)} · ${brief.numbersChecked} numbers checked`
                : ""}
            </span>
            <span className="ml-auto">Quakes per hour</span>
          </div>
          <div ref={chartRef} className="well mx-4 mt-1 h-8 overflow-hidden">
            {perHour && p.from !== null && p.to !== null && chartW > 0 && (
              <AreaSpark
                points={perHour}
                from={p.from}
                to={p.to}
                t={p.t}
                width={chartW - 2}
                height={30}
              />
            )}
          </div>
          <div className="mt-2 min-h-0 flex-1 overflow-y-auto pb-2">
            {p.briefLoading && !brief && (
              <ol aria-label="Loading the brief" className="flex flex-col gap-2 px-4 py-1">
                {[0, 1, 2, 3, 4].map((i) => (
                  <li key={i} className="h-9 rounded-[10px] bg-white/[0.04]" />
                ))}
              </ol>
            )}
            {p.briefError && (
              <p role="alert" className="px-4 py-2 text-small text-varnish">
                The brief could not be loaded: {p.briefError}
              </p>
            )}
            {!p.briefLoading && !p.briefError && !brief && (
              <p className="px-4 py-2 text-small text-graphite">
                {p.brief?.reason ??
                  "No brief yet. The first one is written after the first ingest finds events."}
              </p>
            )}
            {brief && (
              <ol className="flex flex-col gap-1 px-2">
                {brief.bullets.map((b, i) => {
                  const ev = b.event_ids
                    .map((id) => p.eventsById.get(id))
                    .find((e) => e !== undefined);
                  const chip = kindChip(ev?.kind);
                  const on = activeIndex === i;
                  return (
                    <li key={i}>
                      <button
                        type="button"
                        onClick={() => p.onSelect({ from: "brief", index: i })}
                        aria-current={on ? "true" : undefined}
                        className={`group grid w-full grid-cols-[auto_1fr] gap-x-2.5 rounded-[10px] px-2 py-2 text-left transition-colors ${
                          on ? "bg-pen/[0.14] ring-1 ring-pen/50" : "hover:bg-white/[0.06]"
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`mt-px flex size-5 items-center justify-center rounded-full font-mono text-[11px] ${
                            on ? "bg-pen text-on-pen" : "bg-white/10 text-scratch"
                          }`}
                        >
                          {i + 1}
                        </span>
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5">
                            <Chip {...chip} />
                            {ev && (
                              <span className="font-mono text-micro text-graphite">
                                {utcClock(ev.occurredAt)}
                              </span>
                            )}
                            <span className="ml-auto text-micro text-graphite">
                              Cites {b.event_ids.length}{" "}
                              {b.event_ids.length === 1 ? "event" : "events"}
                            </span>
                          </span>
                          <span className="mt-1 block text-small text-scratch">{b.text}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </>
      ) : (
        <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-4 pb-3">
          <p className="text-caption text-graphite">
            {p.presets
              ? "DEMO: no model runs here. Pick a question. Code wrote each answer from the stored facts."
              : "Type a question in the search field. Answers come only from the stored events, with citations."}
          </p>
          {p.presets && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {p.presets.length === 0 && (
                <p className="text-small text-graphite">No preset answers in this recording.</p>
              )}
              {p.presets.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => p.onAsk(q)}
                  className="rounded-full border border-white/15 bg-white/[0.04] px-2.5 py-1 text-left text-small text-scratch hover:border-white/35"
                >
                  {q}
                </button>
              ))}
            </div>
          )}
          <div aria-live="polite" className="mt-2">
            {p.askPending && <p className="text-small text-graphite">Querying the event store</p>}
            {p.ask?.error && <p className="text-small text-varnish">{p.ask.error}</p>}
            {p.ask?.answer && (
              <ol className="flex flex-col gap-1">
                {p.ask.answer.sentences.map((s, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() => p.onSelect({ from: "ask", index: i })}
                      className={`flex w-full gap-2.5 rounded-[10px] px-2 py-2 text-left text-small ${
                        activeIndex === i
                          ? "bg-pen/[0.14] ring-1 ring-pen/50"
                          : "hover:bg-white/[0.06]"
                      }`}
                    >
                      <span className="font-mono text-pen" aria-hidden="true">
                        {i + 1}
                      </span>
                      <span>{s.text}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
