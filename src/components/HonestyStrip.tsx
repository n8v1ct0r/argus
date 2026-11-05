"use client";
// The shared honesty strip of Nate's sidequests: a 32px bar that says what kind of data is on
// screen. A screen that mixes kinds shows the most synthetic one and lists the rest in the
// tooltip. The static deploy mixes DEMO (template brief), LIVE (USGS), and RECORDED (the rest).
import { useEffect, useState } from "react";
import type { ReplaySummary } from "../api/types.ts";
import { snapshotGet } from "../snapshot/client.ts";
import { SNAPSHOT_MODE } from "../snapshot/mode.ts";
import { layerSpans, spanLabel, type Span } from "../snapshot/windows.ts";

const DOT = { live: "#3DDC84", recorded: "#F5B83D", demo: "#9B8CFF" } as const;

function recordedLines(replay: ReplaySummary | null): string[] {
  if (!replay) return ["RECORDED · flights, fires, satellites, natural events, and quakes."];
  const spans = layerSpans(replay);
  const line = (what: string, s: Span | null) =>
    `RECORDED · ${what}: ${s ? spanLabel(s) : "no data"}.`;
  return [
    line("quakes, fires, and natural events", spans.quakes),
    line("flights", spans.flights),
    line("satellite positions, computed from stored orbits", spans.satellites),
  ];
}

export function HonestyStrip() {
  const [replay, setReplay] = useState<ReplaySummary | null>(null);
  useEffect(() => {
    if (!SNAPSHOT_MODE) return;
    snapshotGet("/api/replay")
      .then((r) => setReplay(r as ReplaySummary))
      .catch(() => setReplay(null));
  }, []);

  const kind = SNAPSHOT_MODE ? "DEMO" : "LIVE";
  const source = SNAPSHOT_MODE ? "· template brief" : "· own ingest";
  const dot = SNAPSHOT_MODE ? DOT.demo : DOT.live;
  const title = SNAPSHOT_MODE
    ? [
        "DEMO · template brief: code fills fixed sentences from stored facts. No model runs here.",
        "LIVE · USGS: quakes fetched by your browser now.",
        ...recordedLines(replay),
      ].join("\n")
    : "LIVE · events from this machine's own ingest worker.";

  return (
    <div
      data-honesty-strip
      className="honesty-strip fixed inset-x-0 top-0 z-50 flex h-8 items-center gap-3 border-b px-3"
    >
      <a href="https://nate-victor.com" className="honesty-strip-link shrink-0">
        NATE VICTOR / SIDEQUEST 01
      </a>
      <span className="honesty-strip-name max-[760px]:hidden">· ARGUS</span>
      <span className="ml-auto flex min-w-0 items-center gap-2" title={title}>
        <span
          aria-hidden="true"
          className="inline-block size-1.5 shrink-0 rounded-full"
          style={{ background: dot }}
        />
        {/* The kind never truncates; on a narrow phone only the source after it does. */}
        <span className="shrink-0">{kind}</span>
        <span className="min-w-0 truncate">{source}</span>
        <span className="sr-only">{title}</span>
      </span>
    </div>
  );
}
