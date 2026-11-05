"use client";
// Small charts drawn from recorded data: a magnitude trace and an area sparkline. Both share the
// replay window and draw the replay time as a cursor.
import { useId } from "react";

export interface MagTraceProps {
  quakes: Array<{ t: number; magValue: number; inFinding: boolean }>;
  from: number;
  to: number;
  t: number;
  width: number;
  height: number;
}

/** One stem per quake, height by magnitude; findings in the accent. */
export function MagTrace({ quakes, from, to, t, width, height }: MagTraceProps) {
  const mags = quakes.map((q) => q.magValue);
  const lo = mags.length ? Math.min(...mags) : 0;
  const hi = mags.length ? Math.max(...mags) : 1;
  const span = hi - lo || 1;
  const x = (ms: number) => ((ms - from) / (to - from)) * width;
  const y = (m: number) => height - 4 - ((m - lo) / span) * (height - 12);
  const sorted = [...quakes].sort((a, b) => a.t - b.t);
  const line = sorted.map(
    (q, i) => `${i ? "L" : "M"}${x(q.t).toFixed(1)},${y(q.magValue).toFixed(1)}`,
  );
  return (
    <svg width={width} height={height} className="block" role="presentation">
      {[0.25, 0.5, 0.75].map((f) => (
        <line
          key={f}
          x1={f * width}
          x2={f * width}
          y1={0}
          y2={height}
          className="stroke-white/[0.06]"
        />
      ))}
      <path d={line.join("")} fill="none" className="stroke-white/25" strokeWidth={1} />
      {sorted.map((q, i) => (
        <line
          key={i}
          x1={x(q.t)}
          x2={x(q.t)}
          y1={height}
          y2={y(q.magValue)}
          strokeWidth={q.inFinding ? 1.6 : 1}
          className={
            q.t > t ? "stroke-white/15" : q.inFinding ? "stroke-signal" : "stroke-scratch/80"
          }
        />
      ))}
      <line x1={x(t)} x2={x(t)} y1={0} y2={height} className="stroke-pen" strokeWidth={1.2} />
    </svg>
  );
}

export interface AreaSparkProps {
  points: Array<{ t: number; v: number }>;
  from: number;
  to: number;
  t?: number;
  width: number;
  height: number;
  /** Accent line and fill; otherwise neutral ink. */
  accent?: boolean;
}

export function AreaSpark({ points, from, to, t, width, height, accent }: AreaSparkProps) {
  const gid = useId().replace(/:/g, "");
  const vs = points.map((p) => p.v);
  const hi = vs.length ? Math.max(...vs) : 1;
  const x = (ms: number) => ((ms - from) / (to - from)) * width;
  const y = (v: number) => height - 2 - (v / (hi || 1)) * (height - 6);
  const sorted = [...points].sort((a, b) => a.t - b.t);
  if (!sorted.length) return <svg width={width} height={height} role="presentation" />;
  const line = sorted.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const area = `${line.join("")}L${x(last.t).toFixed(1)},${height}L${x(first.t).toFixed(1)},${height}Z`;
  const ink = accent ? "var(--color-pen)" : "var(--color-scratch)";
  return (
    <svg width={width} height={height} className="block" role="presentation">
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={ink} stopOpacity={accent ? 0.35 : 0.22} />
          <stop offset="1" stopColor={ink} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line.join("")} fill="none" stroke={ink} strokeOpacity={0.9} strokeWidth={1.2} />
      {t !== undefined && (
        <line x1={x(t)} x2={x(t)} y1={0} y2={height} className="stroke-pen" strokeWidth={1.2} />
      )}
    </svg>
  );
}

/** Counts per bin of `binMs` across the window, computed from event times. */
export function binCounts(times: number[], from: number, to: number, binMs: number) {
  const n = Math.max(1, Math.ceil((to - from) / binMs));
  const counts = new Array<number>(n).fill(0);
  for (const t of times) {
    const i = Math.floor((t - from) / binMs);
    if (i >= 0 && i < n) counts[i]! += 1;
  }
  return counts.map((v, i) => ({ t: from + (i + 0.5) * binMs, v }));
}
