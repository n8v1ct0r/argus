"use client";
// The console chrome: the top bar (breadcrumb, replay clock, latency, Ask search, alerts) and
// the left rail (navigation, layer toggles with their data kind, the quake magnitude trace).
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import type { LayerId, ReplaySummary } from "../api/types.ts";
import { MagTrace } from "./Charts.tsx";
import {
  ArgusMark,
  BellIcon,
  ClockIcon,
  ListIcon,
  PinIcon,
  SearchIcon,
  StackIcon,
} from "./icons.tsx";
import { useWidth } from "./useWidth.ts";

function utcSeconds(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

/** Time to first byte of the status request, as the browser measured it. */
export function useStatusLatency(url: string, ready: boolean): number | null {
  const [ms, setMs] = useState<number | null>(null);
  useEffect(() => {
    if (!ready) return;
    const entry = performance.getEntriesByType("resource").find((e) => e.name.includes(url)) as
      PerformanceResourceTiming | undefined;
    if (!entry) return;
    const ttfb =
      entry.responseStart > 0 && entry.requestStart > 0
        ? entry.responseStart - entry.requestStart
        : entry.duration;
    queueMicrotask(() => setMs(Math.max(0, Math.round(ttfb))));
  }, [url, ready]);
  return ms;
}

export interface TopBarProps {
  crumbs: string[];
  t: number | null;
  latencyMs: number | null;
  alerts: number | null;
  onAlerts: () => void;
  presets: string[] | null;
  onAsk: (q: string) => void;
  askPending: boolean;
  compact: boolean;
}

export function TopBar(p: TopBarProps) {
  const [q, setQ] = useState("");
  const listId = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = q.trim();
    if (v && !p.askPending) p.onAsk(v);
  };
  const search = (
    <form onSubmit={submit} role="search" className="min-w-0 flex-1 md:w-[260px] md:flex-none">
      <label className="flex h-8 items-center gap-2 rounded-[9px] border border-white/10 bg-black/30 px-2.5 text-graphite focus-within:border-pen/70">
        <SearchIcon />
        <span className="sr-only">Ask Argus</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          list={p.presets ? listId : undefined}
          maxLength={300}
          placeholder="Ask Argus"
          className="min-w-0 flex-1 bg-transparent text-small text-scratch placeholder:text-graphite focus:outline-none"
        />
        <kbd className="hidden rounded border border-white/15 px-1 font-mono text-[10px] text-graphite md:inline">
          Enter
        </kbd>
      </label>
      {p.presets && (
        <datalist id={listId}>
          {p.presets.map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
      )}
    </form>
  );
  const alerts = (
    <button
      type="button"
      onClick={p.onAlerts}
      title="Brief sentences, each with cited events"
      className="flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] bg-pen px-2.5 text-small font-semibold text-on-pen shadow-[0_6px_18px_-6px_rgb(255_138_61/0.7),inset_0_1px_0_rgb(255_255_255/0.35)] hover:brightness-110"
    >
      <BellIcon />
      Alerts
      <span className="font-mono">{p.alerts ?? 0}</span>
    </button>
  );

  return (
    <header className="glass flex flex-col gap-2 px-3 py-2.5 md:h-[var(--top-h)] md:flex-row md:items-center md:gap-4 md:rounded-[16px] md:py-0">
      <div className="flex min-w-0 items-center gap-3">
        <span aria-hidden="true" className="hidden shrink-0 items-center gap-1.5 md:flex">
          <span className="size-3 rounded-full bg-[#ff5f57] shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.3)]" />
          <span className="size-3 rounded-full bg-[#febc2e] shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.3)]" />
          <span className="size-3 rounded-full bg-[#28c840] shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.3)]" />
        </span>
        <nav aria-label="Breadcrumb" className="min-w-0 truncate text-small">
          {p.crumbs.map((c, i) => (
            <span key={c}>
              {i > 0 && <span className="px-1.5 text-white/30">/</span>}
              <span
                className={
                  i === p.crumbs.length - 1 ? "font-semibold text-scratch" : "text-graphite"
                }
              >
                {c}
              </span>
            </span>
          ))}
        </nav>
        {p.compact && <span className="ml-auto">{alerts}</span>}
      </div>
      <div className="flex min-w-0 items-center gap-3 md:ml-auto md:gap-4">
        <span
          className="flex shrink-0 items-center gap-1.5 font-mono text-caption text-scratch"
          title="Replay time"
        >
          <span className="text-graphite">
            <ClockIcon />
          </span>
          {p.t === null ? "--:--:--" : `${utcSeconds(p.t)} UTC`}
        </span>
        <span
          className="hidden shrink-0 font-mono text-caption text-graphite sm:inline"
          title="Time to first byte of the status file, measured by your browser"
        >
          Latency{" "}
          <span className="text-scratch">{p.latencyMs === null ? "--" : `${p.latencyMs} ms`}</span>
        </span>
        {!p.compact && search}
        {!p.compact && alerts}
      </div>
      {p.compact && search}
    </header>
  );
}

export type NavTarget = "brief" | "events" | "sources" | "replay";

export interface LayerRow {
  id: LayerId | "quakes-live";
  label: string;
  on: boolean;
  kind: "LIVE" | "RECORDED" | null;
  /** The badge's tooltip: for RECORDED, the span this layer's data covers. */
  kindTitle?: string;
  count: number | null;
  note?: string | null;
  onToggle: () => void;
}

function KindBadge({ kind, title }: { kind: "LIVE" | "RECORDED"; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex h-4 items-center rounded-[4px] border px-1 font-mono text-[9.5px] leading-none tracking-[0.06em] ${
        kind === "LIVE" ? "border-live/50 bg-live/10 text-live" : "border-recorded/35 text-recorded"
      }`}
    >
      {kind}
      {title && <span className="sr-only">: {title}</span>}
    </span>
  );
}

const NAV: Array<{ id: NavTarget; label: string; icon: ReactNode }> = [
  { id: "brief", label: "Brief", icon: <ListIcon /> },
  { id: "events", label: "Events", icon: <PinIcon /> },
  { id: "sources", label: "Sources", icon: <StackIcon /> },
  { id: "replay", label: "Replay", icon: <ClockIcon /> },
];

export interface LeftRailProps {
  nav: NavTarget | null;
  onNav: (n: NavTarget) => void;
  layers: LayerRow[];
  replay: ReplaySummary | null;
  from: number | null;
  to: number | null;
  t: number;
  compact: boolean;
}

/** Layer toggles as checkboxes; each row names its data kind and its count at the replay time. */
export function LayerList({ layers }: { layers: LayerRow[] }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {layers.map((l) => (
        <li key={l.id}>
          <label className="flex cursor-pointer items-center gap-2.5 rounded-[9px] px-2 py-1.5 hover:bg-white/[0.06]">
            <input
              type="checkbox"
              checked={l.on}
              onChange={l.onToggle}
              className="size-3.5 shrink-0 cursor-pointer"
            />
            <span
              className={`min-w-0 flex-1 truncate text-small ${l.on ? "text-scratch" : "text-graphite"}`}
            >
              {l.label}
            </span>
            <span className="font-mono text-micro text-graphite">{l.count ?? ""}</span>
            {l.kind && <KindBadge kind={l.kind} title={l.kindTitle} />}
          </label>
          {l.note && <p className="px-2 pb-1 pl-8 text-micro text-varnish">{l.note}</p>}
        </li>
      ))}
    </ul>
  );
}

export function LeftRail(p: LeftRailProps) {
  const [traceRef, traceW] = useWidth<HTMLDivElement>();
  const mags = p.replay?.quakes.map((q) => q.magValue) ?? [];
  const hi = mags.length ? Math.max(...mags) : null;
  const lo = mags.length ? Math.min(...mags) : null;
  return (
    <aside aria-label="Console" className="glass flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <span className="text-pen">
          <ArgusMark />
        </span>
        <h1 className="text-title font-semibold tracking-[-0.01em]">Argus</h1>
        <span className="sr-only">
          A view of Earth and an analyst whose every sentence links to the events behind it.
        </span>
      </div>
      <nav aria-label="Panels" className="px-2">
        <ul className="flex flex-col gap-0.5">
          {NAV.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => p.onNav(n.id)}
                aria-current={p.nav === n.id ? "true" : undefined}
                className={`flex w-full items-center gap-2.5 rounded-[9px] px-2 py-1.5 text-left text-small ${
                  p.nav === n.id
                    ? "bg-white/[0.1] text-scratch shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]"
                    : "text-graphite hover:bg-white/[0.06] hover:text-scratch"
                }`}
              >
                <span className={p.nav === n.id ? "text-pen" : ""}>{n.icon}</span>
                {n.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="mx-4 my-3 h-px bg-white/[0.07]" />
      <h2 className="panel-title px-4 pb-1.5">Layers</h2>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <LayerList layers={p.layers} />
      </div>
      <section aria-labelledby="trace-title" className="well m-3 mt-2 px-2.5 pt-2 pb-2">
        <div className="flex items-baseline justify-between">
          <h2 id="trace-title" className="text-caption font-semibold text-scratch">
            Quake magnitude
          </h2>
          <span className="font-mono text-micro text-graphite">
            {hi !== null && lo !== null ? `M ${lo} to ${hi}` : ""}
          </span>
        </div>
        <div ref={traceRef} className="mt-1.5 h-[68px]">
          {p.replay && p.from !== null && p.to !== null && traceW > 0 ? (
            <MagTrace
              quakes={p.replay.quakes}
              from={p.from}
              to={p.to}
              t={p.t}
              width={traceW}
              height={68}
            />
          ) : (
            <p className="pt-5 text-micro text-graphite">Loading the recorded quakes</p>
          )}
        </div>
        <p className="mt-1 text-micro text-graphite">
          {mags.length} recorded quakes. <span className="text-signal">Orange</span>: in a finding.
        </p>
      </section>
    </aside>
  );
}
