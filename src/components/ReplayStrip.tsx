"use client";
// The drum strip: the last 24 hours as a seismograph record. One trace per layer, the stylus
// is the replay time, and each brief bullet pins a numbered annotation at its events' time.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { ReplaySummary } from "../api/types.ts";
import { PauseIcon, PlayIcon } from "./icons.tsx";

const FIVE_MIN = 5 * 60_000;
const HOUR = 3_600_000;
const LABEL_W = 64;
const ROW_H = 20;
const TOP = 16;
const ROWS = ["Quakes", "Fires", "Flights", "Events"] as const;

export function utcClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

function utcLong(ms: number): string {
  const d = new Date(ms);
  return `${utcClock(ms)}, ${d.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" })}`;
}

export interface ReplayStripProps {
  from: number;
  to: number;
  t: number;
  summary: ReplaySummary | null;
  loading: boolean;
  error: string | null;
  playing: boolean;
  onSeek: (t: number) => void;
  onTogglePlay: () => void;
  pins: Array<{ n: number; t: number }>;
  activePin: number | null;
  onSelectPin: (n: number) => void;
}

export function ReplayStrip(p: ReplayStripProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // 0 until the first measurement: a guessed width would overflow narrow screens.
  const [width, setWidth] = useState(0);
  const dragging = useRef(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      // The measured width, never a minimum: a floor wider than the box (it was 320) pushed the
      // record and its pins past the right edge of a 390px screen.
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = Math.max(1, width - LABEL_W - 12);
  const x = useCallback(
    (ms: number) => LABEL_W + ((ms - p.from) / (p.to - p.from)) * plotW,
    [p.from, p.to, plotW],
  );
  const rowY = (i: number) => TOP + i * ROW_H + ROW_H / 2;
  const height = TOP + ROWS.length * ROW_H + 18;

  const seekFromPointer = (clientX: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const f = (clientX - rect.left - LABEL_W) / plotW;
    p.onSeek(p.from + Math.min(1, Math.max(0, f)) * (p.to - p.from));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = {
      ArrowLeft: -FIVE_MIN,
      ArrowRight: FIVE_MIN,
      PageDown: -HOUR,
      PageUp: HOUR,
    } as Record<string, number>;
    if (e.key in step) {
      e.preventDefault();
      p.onSeek(Math.min(p.to, Math.max(p.from, p.t + (step[e.key] ?? 0))));
    } else if (e.key === "Home") {
      e.preventDefault();
      p.onSeek(p.from);
    } else if (e.key === "End") {
      e.preventDefault();
      p.onSeek(p.to);
    }
  };

  const traces = useMemo(() => {
    const s = p.summary;
    if (!s) return null;
    const qY = rowY(0);
    const quakePaths = s.quakes.map((q) => {
      const cx = x(q.t);
      const a = Math.min(ROW_H / 2 - 1, 2 + q.magValue * 1.6);
      return {
        d: `M${cx - 2},${qY} L${cx - 0.6},${qY - a} L${cx + 0.6},${qY + a * 0.8} L${cx + 2},${qY}`,
        finding: q.inFinding,
        id: q.id,
      };
    });
    const maxFire = Math.max(1, ...s.fires.map((f) => f.count));
    const binW = Math.max(1, (plotW * 30 * 60_000) / (p.to - p.from) - 1);
    const fireBars = s.fires.map((f) => ({
      x: x(f.binStart),
      w: binW,
      o: 0.15 + (0.7 * f.count) / maxFire,
    }));
    const maxFlights = Math.max(1, ...s.flights.map((f) => f.count));
    const flY = rowY(2);
    const flightPts = s.flights.map(
      (f) => [x(f.t), flY + ROW_H / 2 - 3 - ((ROW_H - 6) * f.count) / maxFlights] as const,
    );
    const eventTicks = s.events.map((e) => x(e.t));
    const gapMarks = s.gaps.map((g) => ({
      ...g,
      x0: x(g.from),
      x1: x(g.to),
      row: ["quakes", "fires", "flights", "events"].indexOf(g.layer),
    }));
    return { quakePaths, fireBars, flightPts, eventTicks, gapMarks };
  }, [p.summary, x, plotW, p.from, p.to]);

  const ticks: number[] = [];
  const firstTick = Math.ceil(p.from / (6 * HOUR)) * 6 * HOUR;
  for (let tt = firstTick; tt <= p.to; tt += 6 * HOUR) ticks.push(tt);

  const empty =
    !p.loading &&
    !p.error &&
    p.summary &&
    !p.summary.quakes.length &&
    !p.summary.fires.length &&
    !p.summary.flights.length &&
    !p.summary.events.length;

  return (
    <div id="panel-replay" className="flex h-full items-stretch gap-3 px-3">
      <div className="flex flex-col items-start justify-center gap-1 py-2">
        <button
          type="button"
          onClick={p.onTogglePlay}
          aria-label={p.playing ? "Pause replay" : "Play the last 24 hours"}
          className="flex size-9 items-center justify-center rounded-full bg-white/[0.1] text-scratch shadow-[inset_0_1px_0_rgb(255_255_255/0.12)] hover:bg-white/[0.16] disabled:opacity-40"
          disabled={!p.summary}
        >
          {p.playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <span className="font-mono text-caption text-scratch" aria-hidden="true">
          {utcClock(p.t)}
        </span>
      </div>

      <div
        ref={wrapRef}
        role="slider"
        tabIndex={0}
        aria-label="Replay time"
        aria-valuemin={p.from}
        aria-valuemax={p.to}
        aria-valuenow={Math.round(p.t)}
        aria-valuetext={utcLong(p.t)}
        onKeyDown={onKeyDown}
        onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          seekFromPointer(e.clientX);
        }}
        onPointerMove={(e) => dragging.current && seekFromPointer(e.clientX)}
        onPointerUp={() => (dragging.current = false)}
        className="relative min-w-0 flex-1 cursor-ew-resize touch-none select-none"
      >
        <svg width={width} height={height} className="block" role="presentation">
          {ticks.map((tt) => (
            <g key={tt}>
              <line x1={x(tt)} x2={x(tt)} y1={TOP - 4} y2={height - 16} className="stroke-hair" />
              <text
                x={x(tt)}
                y={height - 4}
                textAnchor="middle"
                className="fill-graphite font-mono text-[11px]"
              >
                {utcClock(tt).slice(0, 5)}
              </text>
            </g>
          ))}
          {ROWS.map((label, i) => (
            <g key={label}>
              <text
                x={LABEL_W - 8}
                y={rowY(i) + 4}
                textAnchor="end"
                className="fill-graphite text-[11px]"
              >
                {label}
              </text>
              <line
                x1={LABEL_W}
                x2={LABEL_W + plotW}
                y1={rowY(i)}
                y2={rowY(i)}
                className={p.loading || !traces ? "stroke-hair" : "stroke-hair-strong"}
                strokeDasharray={p.loading ? "1 4" : undefined}
              />
            </g>
          ))}

          {traces && (
            <>
              {traces.fireBars.map((b, i) => (
                <rect
                  key={i}
                  x={b.x}
                  y={rowY(1) - ROW_H / 2 + 3}
                  width={b.w}
                  height={ROW_H - 6}
                  className="fill-scratch"
                  fillOpacity={b.o}
                />
              ))}
              {traces.quakePaths.map((q) => (
                <path
                  key={q.id}
                  d={q.d}
                  fill="none"
                  strokeWidth={q.finding ? 1.6 : 1.2}
                  className={q.finding ? "stroke-signal" : "stroke-scratch"}
                />
              ))}
              {traces.flightPts.length > 1 && (
                <polyline
                  points={traces.flightPts.map(([a, b]) => `${a},${b}`).join(" ")}
                  fill="none"
                  strokeWidth={1.2}
                  className="stroke-scratch"
                />
              )}
              {traces.eventTicks.map((ex, i) => (
                <line
                  key={i}
                  x1={ex}
                  x2={ex}
                  y1={rowY(3) - 7}
                  y2={rowY(3) + 7}
                  strokeWidth={1.4}
                  className="stroke-scratch"
                />
              ))}
              {traces.gapMarks.map((g, i) =>
                g.row < 0 ? null : g.state === "stale" ? (
                  <line
                    key={i}
                    x1={g.x0}
                    x2={g.x1}
                    y1={rowY(g.row)}
                    y2={rowY(g.row)}
                    strokeWidth={1.6}
                    strokeDasharray="4 3"
                    className="stroke-varnish"
                  />
                ) : (
                  <g key={i} className="stroke-varnish" strokeWidth={1.4}>
                    <rect
                      x={g.x0}
                      y={rowY(g.row) - 3}
                      width={Math.max(2, g.x1 - g.x0)}
                      height={6}
                      className="fill-soot stroke-none"
                    />
                    <line x1={g.x0} x2={g.x0} y1={rowY(g.row) - 7} y2={rowY(g.row) + 7} />
                    <line x1={g.x1} x2={g.x1} y1={rowY(g.row) - 7} y2={rowY(g.row) + 7} />
                  </g>
                ),
              )}
            </>
          )}

          <line
            x1={x(p.t)}
            x2={x(p.t)}
            y1={4}
            y2={height - 16}
            strokeWidth={1.5}
            className="stroke-pen"
          />
          <rect x={x(p.t) - 5} y={2} width={10} height={7} className="fill-pen" />
        </svg>

        {width > 0 &&
          p.pins.map((pin) => (
            <button
              key={pin.n}
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => p.onSelectPin(pin.n)}
              aria-label={`Brief bullet ${pin.n}`}
              aria-pressed={p.activePin === pin.n}
              style={{ left: x(pin.t) - 8, top: 0 }}
              className={`absolute flex size-4 items-center justify-center rounded-full border font-mono text-[9px] leading-none font-semibold ${
                p.activePin === pin.n
                  ? "border-pen bg-pen text-on-pen"
                  : "border-pen bg-night text-pen"
              }`}
            >
              {pin.n}
            </button>
          ))}

        {(p.loading || p.error || empty) && (
          <p
            role="status"
            className={`pointer-events-none absolute left-[72px] top-1 text-caption ${p.error ? "text-varnish" : "text-graphite"}`}
          >
            {p.error
              ? `Replay unavailable: ${p.error}`
              : p.loading
                ? "Loading the last 24 hours"
                : "No stored events in this window yet. The ingest worker fills it as sources report."}
          </p>
        )}
      </div>
    </div>
  );
}
