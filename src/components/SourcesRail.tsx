"use client";
// One row per layer: toggle, state drawn as a stroke (solid live, dashed stale, gap error,
// dotted off), when it last reported, and its source credit.
import { config } from "../../argus.config.ts";
import type { LayerId, SourceState, StatusPayload } from "../api/types.ts";
import { SNAPSHOT_MODE } from "../snapshot/mode.ts";
import { recordedTitle, spanLabel, type Span } from "../snapshot/windows.ts";
import { utcClock } from "./ReplayStrip.tsx";

function StateStroke({ state }: { state: SourceState }) {
  const common = { x1: 1, x2: 31, y1: 5, y2: 5, strokeWidth: 1.6 };
  return (
    <svg width="32" height="10" aria-hidden="true" className="shrink-0">
      {state === "live" && <line {...common} className="stroke-scratch" />}
      {state === "stale" && <line {...common} strokeDasharray="4 3" className="stroke-varnish" />}
      {state === "off" && (
        <line {...common} strokeDasharray="1 3" strokeLinecap="round" className="stroke-graphite" />
      )}
      {state === "error" && (
        <g className="stroke-varnish" strokeWidth={1.6}>
          <line x1={1} x2={11} y1={5} y2={5} />
          <line x1={21} x2={31} y1={5} y2={5} />
          <line x1={13} x2={13} y1={1} y2={9} />
          <line x1={19} x2={19} y1={1} y2={9} />
        </g>
      )}
    </svg>
  );
}

const STATE_WORDS: Record<SourceState, string> = {
  live: "Live",
  stale: "Stale",
  error: "Not responding",
  off: "Off",
};

export interface SourcesRailProps {
  visible: Record<LayerId, boolean>;
  onToggle: (id: LayerId) => void;
  status: StatusPayload | null;
  statusError: string | null;
  counts: Partial<Record<LayerId, number>>;
  /** Static deploy: the recorded window, from the first stored fetch to the newest. */
  recording?: { from: number; to: number } | null;
  /** Static deploy: the span each layer's data covers. Layers were captured over different spans. */
  spans?: Record<LayerId, Span | null> | null;
  /** Static deploy: the live USGS row. */
  live?: {
    on: boolean;
    onToggle: () => void;
    count: number | null;
    fetchedAt: number | null;
    error: string | null;
  } | null;
}

function utcStamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function KindTag({ kind }: { kind: "LIVE" | "RECORDED" }) {
  return (
    <span
      className={`font-mono text-[10px] leading-4 tracking-[0.06em] ${
        // The 1 live row gets the box; the 5 recorded rows stay quiet so the tag never repeats
        // as an accent down the rail.
        kind === "LIVE"
          ? "rounded-[2px] border border-[#3DDC84]/60 px-1 text-[#3DDC84]"
          : "text-[#F5B83D]"
      }`}
    >
      {kind}
    </span>
  );
}

export function SourcesRail(p: SourcesRailProps) {
  return (
    <section aria-labelledby="sources-title" className="flex min-h-0 flex-col">
      <h2 id="sources-title" className="px-4 pt-4 pb-2 text-title font-semibold">
        Sources
      </h2>
      {SNAPSHOT_MODE && (
        <p className="px-4 pb-3 text-caption text-graphite">
          {p.recording
            ? `Argus's own ingest ran from ${utcStamp(p.recording.from)} to ${utcStamp(p.recording.to)}. Each row shows the span its data covers.`
            : "Loading the recording"}
        </p>
      )}
      {p.statusError && (
        <p role="alert" className="px-4 pb-2 text-small text-varnish">
          Source status unavailable: {p.statusError}
        </p>
      )}
      <ul className="flex flex-col">
        {config.layers.map((layer) => {
          const id = layer.id as LayerId;
          const on = p.visible[id];
          const s = p.status?.sources[id];
          const state: SourceState = !on ? "off" : (s?.state ?? "stale");
          const count = p.counts[id];
          const span = p.spans?.[id];
          return (
            <li key={id} className="border-t border-hair">
              <button
                type="button"
                aria-pressed={on}
                onClick={() => p.onToggle(id)}
                className="group flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-scratch/[0.04]"
              >
                <span className="flex items-center gap-3">
                  <StateStroke state={state} />
                  <span
                    className={`text-body font-semibold ${on ? "text-scratch" : "text-graphite"}`}
                  >
                    {layer.label}
                  </span>
                  <span className="ml-auto font-mono text-caption text-graphite tabular-nums">
                    {count === undefined ? "" : `${count}`}
                  </span>
                </span>
                <span className="flex items-center gap-2 pl-[44px] text-caption text-graphite">
                  {SNAPSHOT_MODE && on ? (
                    <>
                      <KindTag kind="RECORDED" />
                      {span !== undefined && (
                        <span className="font-mono" title={recordedTitle(id, span)}>
                          {span ? spanLabel(span) : "No data"}
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      <span
                        className={state === "stale" || state === "error" ? "text-varnish" : ""}
                      >
                        {s === undefined && on ? "Checking" : STATE_WORDS[state]}
                      </span>
                      {s?.lastOkAt ? (
                        <span className="font-mono">{utcClock(s.lastOkAt)}</span>
                      ) : null}
                    </>
                  )}
                </span>
                <span className="pl-[44px] text-caption text-graphite">{layer.shortCredit}</span>
              </button>
            </li>
          );
        })}
        {p.live && (
          <li className="border-t border-hair">
            <button
              type="button"
              aria-pressed={p.live.on}
              onClick={p.live.onToggle}
              className="group flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-scratch/[0.04]"
            >
              <span className="flex items-center gap-3">
                <svg width="32" height="10" aria-hidden="true" className="shrink-0">
                  {p.live.on ? (
                    <line x1={1} x2={31} y1={5} y2={5} strokeWidth={1.6} stroke="#3DDC84" />
                  ) : (
                    <line
                      x1={1}
                      x2={31}
                      y1={5}
                      y2={5}
                      strokeWidth={1.6}
                      strokeDasharray="1 3"
                      strokeLinecap="round"
                      className="stroke-graphite"
                    />
                  )}
                </svg>
                <span
                  className={`text-body font-semibold ${p.live.on ? "text-scratch" : "text-graphite"}`}
                >
                  Quakes now
                </span>
                <span className="ml-auto font-mono text-caption text-graphite tabular-nums">
                  {p.live.count === null ? "" : `${p.live.count}`}
                </span>
              </span>
              <span className="flex items-center gap-2 pl-[44px] text-caption text-graphite">
                {p.live.error ? (
                  <span className="text-varnish">
                    USGS did not answer. Recorded quakes still show.
                  </span>
                ) : p.live.fetchedAt ? (
                  <>
                    <KindTag kind="LIVE" />
                    <span className="font-mono">{utcClock(p.live.fetchedAt)}</span>
                  </>
                ) : (
                  <span>Fetching from USGS</span>
                )}
              </span>
              <span className="pl-[44px] text-caption text-graphite">
                USGS past day feed, minus quakes already recorded. Green rings.
              </span>
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}
