"use client";
// The bottom row's data panels: the event inspector (one stored event's facts as a grid) and the
// counts at the replay time, each copied from the recorded layer payloads.
import { useState } from "react";
import type { CitationEvent, ReplaySummary } from "../api/types.ts";
import { Chip, kindChip } from "./BriefRail.tsx";
import { AreaSpark } from "./Charts.tsx";
import { utcClock } from "./ReplayStrip.tsx";
import { useWidth } from "./useWidth.ts";

const MAX_FACTS = 8;

export interface InspectorPanelProps {
  /** The events to inspect: the cited events of the open sentence, or the default event. */
  events: CitationEvent[];
  /** Why these events are shown, for the subtitle. */
  reason: string;
  loading: boolean;
  error: string | null;
}

export function InspectorPanel(p: InspectorPanelProps) {
  const [pick, setPick] = useState(0);
  const key = p.events.map((e) => e.id).join(",");
  const [forKey, setForKey] = useState(key);
  if (forKey !== key) {
    setForKey(key);
    setPick(0);
  }
  const i = Math.min(pick, Math.max(0, p.events.length - 1));
  const ev = p.events[i] ?? null;
  const facts = ev ? Object.entries(ev.facts).slice(0, MAX_FACTS) : [];

  return (
    <section
      id="panel-events"
      tabIndex={-1}
      aria-labelledby="inspector-title"
      className="flex min-h-0 flex-1 flex-col outline-none"
    >
      <div className="flex items-center gap-2 px-4 pt-3.5">
        <h2 id="inspector-title" className="text-title font-semibold">
          Event inspector
        </h2>
        {p.events.length > 1 && (
          <div className="ml-auto flex items-center gap-1 font-mono text-micro text-graphite">
            <button
              type="button"
              aria-label="Previous cited event"
              onClick={() => setPick((n) => (n - 1 + p.events.length) % p.events.length)}
              className="rounded-[6px] px-1.5 py-0.5 hover:bg-white/10 hover:text-scratch"
            >
              Prev
            </button>
            <span>
              {i + 1} of {p.events.length}
            </span>
            <button
              type="button"
              aria-label="Next cited event"
              onClick={() => setPick((n) => (n + 1) % p.events.length)}
              className="rounded-[6px] px-1.5 py-0.5 hover:bg-white/10 hover:text-scratch"
            >
              Next
            </button>
          </div>
        )}
      </div>
      <p className="px-4 text-micro text-graphite">{p.reason}</p>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-3">
        {p.loading && !ev && <p className="text-small text-graphite">Loading the stored event</p>}
        {p.error && (
          <p role="alert" className="text-small text-varnish">
            The stored event could not be loaded: {p.error}
          </p>
        )}
        {!p.loading && !p.error && !ev && (
          <p className="text-small text-graphite">
            Click a sentence or a quake on the globe to inspect its stored record.
          </p>
        )}
        {ev && (
          <>
            <div className="flex items-center gap-2">
              <Chip {...kindChip(ev.kind)} />
              <h3 className="min-w-0 truncate text-body font-semibold" title={ev.title}>
                {ev.title}
              </h3>
            </div>
            <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 max-[420px]:grid-cols-1">
              {facts.map(([k, f]) => (
                <div key={k} className="flex min-w-0 items-baseline gap-2">
                  <dt className="w-[76px] shrink-0 truncate text-micro text-graphite uppercase">
                    {k.replaceAll("_", " ")}
                  </dt>
                  <dd
                    className="min-w-0 font-mono text-caption [overflow-wrap:anywhere] text-scratch"
                    title={f.text}
                  >
                    {f.text}
                    {f.unit && !f.text.endsWith(f.unit) ? ` ${f.unit}` : ""}
                  </dd>
                </div>
              ))}
              <div className="flex min-w-0 items-baseline gap-2">
                <dt className="w-[76px] shrink-0 text-micro text-graphite uppercase">Fetched</dt>
                <dd className="font-mono text-caption text-scratch">{utcClock(ev.fetchedAt)}</dd>
              </div>
              <div className="col-span-full flex min-w-0 items-baseline gap-2">
                <dt className="w-[76px] shrink-0 text-micro text-graphite uppercase">Source id</dt>
                <dd className="min-w-0 truncate font-mono text-caption text-scratch" title={ev.id}>
                  {ev.id}
                </dd>
              </div>
            </dl>
            <p className="mt-2 truncate text-micro text-graphite">{ev.credit}</p>
          </>
        )}
      </div>
    </section>
  );
}

export interface Stat {
  label: string;
  value: number | undefined;
  /** Shown instead of the value while it is missing. */
  pending: string;
  kind: "LIVE" | "RECORDED";
}

export interface StatsPanelProps {
  stats: Stat[];
  t: number | null;
  replay: ReplaySummary | null;
  from: number | null;
  to: number | null;
}

export function StatsPanel(p: StatsPanelProps) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const fires = p.replay?.fires.map((b) => ({ t: b.binStart, v: b.count })) ?? [];
  return (
    <section aria-labelledby="stats-title" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-baseline gap-2 px-4 pt-3.5">
        <h2 id="stats-title" className="text-title font-semibold">
          On the globe
        </h2>
        <span className="ml-auto font-mono text-micro text-graphite">
          {p.t === null ? "" : `at ${utcClock(p.t)}`}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 pt-2">
        {p.stats.map((s) => (
          <div key={s.label} className="flex min-w-0 flex-col-reverse">
            <dt className="mt-0.5 flex items-center gap-1.5 text-micro text-graphite">
              <span className="truncate">{s.label}</span>
              <span
                className={`size-1.5 shrink-0 rounded-full ${s.kind === "LIVE" ? "bg-live" : "bg-recorded"}`}
                title={s.kind}
              />
            </dt>
            <dd className="text-[1.75rem] leading-[2rem] font-light tracking-[-0.03em] text-scratch">
              {s.value === undefined ? (
                <span className="text-small font-normal tracking-normal text-graphite">
                  {s.pending}
                </span>
              ) : (
                s.value.toLocaleString("en-US")
              )}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-auto px-4 pt-2 pb-3">
        <div className="mb-1 flex justify-between text-micro text-graphite">
          <span>Fire detections per 30 min</span>
          <span>Recorded</span>
        </div>
        <div ref={ref} className="well h-[38px] overflow-hidden">
          {p.from !== null && p.to !== null && w > 0 && fires.length > 0 && (
            <AreaSpark
              points={fires}
              from={p.from}
              to={p.to}
              t={p.t ?? undefined}
              width={w - 2}
              height={36}
            />
          )}
        </div>
      </div>
    </section>
  );
}
