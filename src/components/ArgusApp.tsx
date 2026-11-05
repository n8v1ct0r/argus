"use client";
// The Argus console. Desktop: the globe as the hero behind dark glass; a top bar, a left rail
// with layers, a bottom row (event inspector, counts, the brief feed), and the replay record.
// A sentence opens the citations sheet over the globe. Phones: one scrolling column, and the
// 3D globe loads when the visitor asks for it (a still of Earth shows until then).
import type { Globe, LonLat } from "@argus/globe";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { config } from "../../argus.config.ts";
import type {
  AskResponse,
  BriefPayload,
  CitationEvent,
  EventsPayload,
  LayerId,
  LayerPayload,
  ReplaySummary,
  SatelliteGrid,
  StatusPayload,
} from "../api/types.ts";
import { snapshotAsk, snapshotManifest, type PresetAnswer } from "../snapshot/client.ts";
import { useLiveQuakes } from "../snapshot/live-usgs.ts";
import { SNAPSHOT_MODE } from "../snapshot/mode.ts";
import type { SnapshotManifest } from "../snapshot/types.ts";
import {
  crumbLabel,
  isPartial,
  layerSpans,
  recordedTitle,
  spanLabel,
} from "../snapshot/windows.ts";
import { CitationSheet, FeedPanel, type Selection } from "./BriefRail.tsx";
import {
  LeftRail,
  TopBar,
  useStatusLatency,
  type LayerRow,
  type NavTarget,
} from "./ConsoleChrome.tsx";
import { GlobeHud } from "./GlobeHud.tsx";
import { GlobeStage, type GlobeFocus, type GlobeStatus } from "./GlobeStage.tsx";
import { CloseIcon } from "./icons.tsx";
import { InspectorPanel, StatsPanel, type Stat } from "./Panels.tsx";
import { ReplayStrip } from "./ReplayStrip.tsx";
import { SourcesRail } from "./SourcesRail.tsx";
import { useApi, useReducedMotion } from "./useApi.ts";

/** What the globe area says while it is not drawing. */
const GLOBE_MESSAGES: Record<Exclude<GlobeStatus, "ready">, string> = {
  loading: "Loading the globe",
  "start-failed":
    "The globe could not start because this browser has no working WebGL. The sources, the brief, and citations still work.",
  "render-failed":
    "The globe stopped drawing. Reload the page to try again. The sources, the brief, and citations still work.",
};
const DAY = 24 * 3_600_000;
const FLIGHT_BUCKET = 10 * 60_000;
const FIRE_BUCKET = 3_600_000;
// Replay speed: 24 hours in 48 seconds.
const REPLAY_MS_PER_MS = DAY / 48_000;

const ALL_ON: Record<LayerId, boolean> = {
  quakes: true,
  fires: true,
  flights: true,
  satellites: true,
  events: true,
};

/** Short layer names for the rail; credits and long names stay in argus.config.ts. */
const RAIL_LABEL: Record<LayerId, string> = {
  quakes: "Quakes",
  fires: "Fires",
  flights: "Flights",
  satellites: "Satellites",
  events: "EONET",
};

const STATUS_URL = SNAPSHOT_MODE ? "/snapshot/status.json" : "/api/status";

/** Null until the first client render knows the viewport, so the page never lays out twice. */
function useIsPhone(): boolean | null {
  const [phone, setPhone] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 760px)");
    const update = () => setPhone(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return phone;
}

/**
 * True once the page has loaded and the browser is idle. Cesium is 6 MB of script; starting it
 * after the console has painted keeps the text readable first. The globe box shows a still
 * picture of Earth until then.
 */
function useAfterLoadIdle(): boolean {
  const [go, setGo] = useState(false);
  useEffect(() => {
    let idle = 0;
    let timer = 0;
    const start = () => {
      if (typeof window.requestIdleCallback === "function") {
        idle = window.requestIdleCallback(() => setGo(true), { timeout: 1500 });
      } else {
        timer = window.setTimeout(() => setGo(true), 200);
      }
    };
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });
    return () => {
      window.removeEventListener("load", start);
      if (idle) window.cancelIdleCallback(idle);
      if (timer) window.clearTimeout(timer);
    };
  }, []);
  return go;
}

/**
 * Camera targets, highlight ids, and an optional aircraft track for a set of cited events.
 * `members` are the stored events behind cited counts and detections; their positions join the
 * camera target so a count that cites quakes around the world frames all of them.
 */
function focusFrom(events: CitationEvent[], members: CitationEvent[] = []) {
  const points: LonLat[] = [];
  const highlight = new Set<string>();
  let track: { id: string; path: LonLat[] } | null = null;
  for (const e of events) {
    highlight.add(e.id);
    for (const m of e.members) highlight.add(m);
    if (e.kind === "fire_cell_day" && e.facts.cell) highlight.add(e.facts.cell.text);
    if (e.lat !== null && e.lon !== null) points.push([e.lon, e.lat]);
    if (e.bbox) {
      points.push([e.bbox[0], e.bbox[1]], [e.bbox[2], e.bbox[3]]);
    }
    // A circling detection's stored record holds the track samples it was found in.
    if (e.kind === "aircraft_track" || (e.kind === "detection" && e.record.includes('"samples"'))) {
      try {
        const parsed = JSON.parse(e.record) as
          Array<{ lon: number; lat: number }> | { samples?: Array<{ lon: number; lat: number }> };
        const samples = Array.isArray(parsed) ? parsed : (parsed.samples ?? []);
        track = { id: e.id, path: samples.map((s) => [s.lon, s.lat] as LonLat) };
        points.push(...track.path);
      } catch {
        // A track that cannot be parsed is simply not drawn.
      }
    }
  }
  for (const m of members) {
    if (m.lat !== null && m.lon !== null) points.push([m.lon, m.lat]);
  }
  return { points, highlight: [...highlight], track };
}

/** The still shown while Cesium loads: the start view, all layers off. */
const GLOBE_STILL = "/imagery/globe-still.webp";
const GLOBE_STILL_PX = 640;

/** The view around a cited aircraft track: close enough to see the loops. */
const TRACK_SPAN_DEG = 2.5;

/** The API's limit on ids per /api/events request. */
const MAX_IDS = 50;

function focusPanel(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  const target =
    el.querySelector<HTMLElement>('[role="slider"]') ??
    (el.tabIndex >= 0 ? el : el.querySelector<HTMLElement>("button, [tabindex]"));
  target?.focus({ preventScroll: true });
}

export function ArgusApp() {
  const reducedMotion = useReducedMotion();
  const phone = useIsPhone();
  const creditRef = useRef<HTMLDivElement>(null);
  const [globeStatus, setGlobeStatus] = useState<GlobeStatus>("loading");
  const [globe, setGlobe] = useState<Globe | null>(null);
  const idle = useAfterLoadIdle();
  // Phones load the 3D globe on request (a tap on the still, or a sentence that needs it).
  const [globeWanted, setGlobeWanted] = useState(false);
  const globeGo = phone ? globeWanted : idle;

  const status = useApi<StatusPayload>("/api/status");
  const to = status.data?.now ?? null;
  const from = to === null ? null : to - DAY;
  const latency = useStatusLatency(STATUS_URL, status.data !== null);
  // The replay time the visitor chose; null means "now" (the end of the window).
  const [userT, setUserT] = useState<number | null>(null);
  // While true, the replay time follows the newest cited event of the open selection.
  const [followCited, setFollowCited] = useState(false);

  const [visible, setVisible] = useState(ALL_ON);
  const [playing, setPlaying] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [feedMode, setFeedMode] = useState<"brief" | "ask">("brief");
  const [nav, setNav] = useState<NavTarget | null>("brief");
  const select = useCallback((s: Selection) => {
    setSelection(s);
    setFollowCited(s !== null);
    setPlaying(false);
    if (s !== null) {
      setSourcesOpen(false);
      setGlobeWanted(true);
      // On a phone the globe sits above the feed: bring it into view so the flight is seen.
      if (window.matchMedia("(max-width: 760px)").matches) {
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        document
          .querySelector(".argus-globe-box")
          ?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
      }
    }
  }, []);

  const win = from !== null && to !== null ? `from=${from}&to=${to}` : null;
  const brief = useApi<BriefPayload>(to !== null ? "/api/brief" : null);
  const replay = useApi<ReplaySummary>(win ? `/api/replay?${win}` : null);
  const quakes = useApi<LayerPayload>(win ? `/api/layers/quakes?${win}` : null);
  const events = useApi<LayerPayload>(win ? `/api/layers/events?${win}` : null);
  // Only the globe draws satellites (1.2 MB recorded), so they wait for it.
  const satellites = useApi<SatelliteGrid>(
    win && globeStatus === "ready" ? `/api/layers/satellites?${win}&step=300` : null,
  );

  // Every event the brief cites, for the feed's kind chips and the strip's numbered pins.
  const briefIds = useMemo(
    () => [...new Set(brief.data?.brief?.bullets.flatMap((b) => b.event_ids) ?? [])],
    [brief.data],
  );
  const briefEvents = useApi<EventsPayload>(
    briefIds.length ? `/api/events?ids=${encodeURIComponent(briefIds.join(","))}` : null,
  );
  const briefById = useMemo(
    () => new Map(briefEvents.data?.events.map((e) => [e.id, e]) ?? []),
    [briefEvents.data],
  );
  const pins = useMemo(() => {
    return (brief.data?.brief?.bullets ?? []).flatMap((b, i) => {
      const times = b.event_ids
        .map((id) => briefById.get(id)?.occurredAt)
        .filter((v): v is number => v !== undefined);
      return times.length ? [{ n: i + 1, t: Math.min(...times) }] : [];
    });
  }, [brief.data, briefById]);

  // Static deploy: the recording's manifest and the preset Ask answers.
  const [manifest, setManifest] = useState<SnapshotManifest | null>(null);
  const [presets, setPresets] = useState<PresetAnswer[] | null>(null);
  useEffect(() => {
    if (!SNAPSHOT_MODE) return;
    snapshotManifest()
      .then(setManifest)
      .catch(() => setManifest(null));
    snapshotAsk()
      .then(setPresets)
      .catch(() => setPresets([]));
  }, []);

  // Ask Argus.
  const [ask, setAsk] = useState<AskResponse | null>(null);
  const [askPending, setAskPending] = useState(false);
  const onAsk = useCallback(
    async (question: string) => {
      setFeedMode("ask");
      if (SNAPSHOT_MODE) {
        // DEMO: the answer was written by code from templates when the snapshot was exported.
        const preset = presets?.find((p) => p.question === question);
        setAsk(
          preset?.response ?? {
            answer: null,
            error: "This demo answers only the preset questions.",
          },
        );
        if (preset?.response.answer?.sentences.length) select({ from: "ask", index: 0 });
        return;
      }
      setAskPending(true);
      setAsk(null);
      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question }),
        });
        const body = (await res.json().catch(() => null)) as AskResponse | null;
        setAsk(body ?? { answer: null, error: `The server answered ${res.status}.` });
        if (body?.answer?.sentences.length) select({ from: "ask", index: 0 });
      } catch (err) {
        setAsk({ answer: null, error: err instanceof Error ? err.message : String(err) });
      } finally {
        setAskPending(false);
      }
    },
    [select, presets],
  );

  // Citations for the selected sentence drive the camera and the highlight rings.
  const sentence = useMemo(() => {
    if (!selection || selection.from === "pick") return null;
    return selection.from === "brief"
      ? (brief.data?.brief?.bullets[selection.index] ?? null)
      : (ask?.answer?.sentences[selection.index] ?? null);
  }, [selection, brief.data, ask]);
  const selectedIds = useMemo(() => {
    if (!selection) return [];
    if (selection.from === "pick") return selection.ids;
    return sentence?.event_ids ?? [];
  }, [selection, sentence]);
  const citations = useApi<EventsPayload>(
    selectedIds.length ? `/api/events?ids=${encodeURIComponent(selectedIds.join(","))}` : null,
  );
  // Members of cited counts and detections that have no position of their own.
  const memberIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of citations.data?.events ?? []) {
      if (e.lat === null && e.bbox === null) e.members.forEach((m) => ids.add(m));
    }
    return [...ids].slice(0, MAX_IDS);
  }, [citations.data]);
  const members = useApi<EventsPayload>(
    memberIds.length ? `/api/events?ids=${encodeURIComponent(memberIds.join(","))}` : null,
  );
  const cited = useMemo(
    () =>
      selection && citations.data
        ? focusFrom(
            citations.data.events,
            memberIds.length && !members.loading ? (members.data?.events ?? []) : [],
          )
        : null,
    [selection, citations.data, memberIds, members.data, members.loading],
  );
  const highlight = useMemo(() => cited?.highlight ?? [], [cited]);
  const track = cited?.track ?? null;
  const focus: GlobeFocus | null = useMemo(
    () =>
      cited
        ? { points: cited.points, ...(cited.track ? { minSpanDeg: TRACK_SPAN_DEG } : {}) }
        : null,
    [cited],
  );
  const citedTime = useMemo(() => {
    const times = citations.data?.events.map((e) => e.occurredAt) ?? [];
    return times.length ? Math.max(...times) : null;
  }, [citations.data]);
  const clampT = (v: number) =>
    from !== null && to !== null ? Math.min(to, Math.max(from, v)) : v;
  const time =
    followCited && selection && citedTime !== null ? clampT(citedTime) : (userT ?? to ?? 0);

  // Flights and fires are the large recorded payloads (one file per frame or hour). They load
  // after the page is idle, and then only the file for the replay time.
  const flightAt = to !== null && idle ? Math.floor(time / FLIGHT_BUCKET) * FLIGHT_BUCKET : null;
  const fireAt = to !== null && idle ? Math.floor(time / FIRE_BUCKET) * FIRE_BUCKET : null;
  const flights = useApi<LayerPayload>(
    flightAt !== null ? `/api/layers/flights?at=${flightAt}` : null,
  );
  const fires = useApi<LayerPayload>(fireAt !== null ? `/api/layers/fires?at=${fireAt}` : null);

  // Autoplay (off under reduced motion unless the visitor presses play).
  useEffect(() => {
    if (!playing || from === null || to === null) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      setUserT((prev) => {
        const next = (prev ?? from) + dt * REPLAY_MS_PER_MS;
        if (next >= to) {
          setPlaying(false);
          return to;
        }
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, from, to]);

  const quakeItems = quakes.data?.layer === "quakes" ? quakes.data.items : null;
  const recordedQuakeIds = useMemo(() => quakeItems?.map((q) => q.id) ?? null, [quakeItems]);
  const [liveOn, setLiveOn] = useState(true);
  const live = useLiveQuakes(SNAPSHOT_MODE, recordedQuakeIds);
  const eventItems = events.data?.layer === "events" ? events.data.items : null;
  const fireItems = fires.data?.layer === "fires" ? fires.data.items : null;
  const flightItems = flights.data?.layer === "flights" ? flights.data.items : null;

  const counts: Partial<Record<LayerId, number>> = {
    quakes: quakeItems?.filter((q) => q.occurredAt <= time).length,
    events: eventItems?.filter((e) => e.occurredAt <= time).length,
    fires: fireItems?.reduce((n, c) => n + c.count, 0),
    flights: flightItems?.length,
    satellites: satellites.data?.ids.length,
  };

  // The inspector's default: the strongest recorded quake in the window.
  const strongestId = useMemo(() => {
    if (!quakeItems?.length) return null;
    return quakeItems.reduce((a, b) => (b.magValue > a.magValue ? b : a)).id;
  }, [quakeItems]);
  const strongest = useApi<EventsPayload>(
    strongestId && !selection ? `/api/events?ids=${encodeURIComponent(strongestId)}` : null,
  );
  const inspector = selection
    ? {
        events: citations.data?.events ?? [],
        reason:
          selection.from === "pick"
            ? "Picked on the globe."
            : `Cited by ${selection.from === "brief" ? `sentence ${selection.index + 1}` : "the answer"}.`,
        loading: citations.loading,
        error: citations.error,
      }
    : {
        events: strongest.data?.events ?? [],
        reason: "The strongest recorded quake in the window.",
        loading: strongest.loading || quakes.loading,
        error: strongest.error,
      };

  const onPick = useCallback(
    (layerId: string, id: string) => {
      // Picking a quake or a natural event opens its stored record in the citation panel.
      if (layerId === "quakes" || layerId === "events") select({ from: "pick", ids: [id] });
    },
    [select],
  );

  const visibleCredits = config.layers
    .filter((l) => visible[l.id as LayerId])
    .map((l) => l.shortCredit);
  if (SNAPSHOT_MODE && liveOn && !visible.quakes) visibleCredits.push("USGS");

  // Static deploy: each layer's own recorded span, read from the replay summary.
  const spans = useMemo(
    () => (SNAPSHOT_MODE && replay.data ? layerSpans(replay.data) : null),
    [replay.data],
  );

  const layerRows: LayerRow[] = config.layers.map((l) => {
    const id = l.id as LayerId;
    const s = status.data?.sources[id];
    const state = s?.state;
    return {
      id,
      label: RAIL_LABEL[id],
      on: visible[id],
      kind: SNAPSHOT_MODE ? "RECORDED" : state === "live" ? "LIVE" : null,
      kindTitle: SNAPSHOT_MODE && spans ? recordedTitle(id, spans[id]) : undefined,
      count: visible[id] ? (counts[id] ?? null) : null,
      note:
        !SNAPSHOT_MODE && visible[id] && (state === "stale" || state === "error")
          ? state === "stale"
            ? "Stale"
            : "Not responding"
          : SNAPSHOT_MODE && spans && replay.data && isPartial(spans[id], replay.data)
            ? `Recorded ${spanLabel(spans[id]!)} only.`
            : null,
      onToggle: () => setVisible((v) => ({ ...v, [id]: !v[id] })),
    };
  });
  if (SNAPSHOT_MODE) {
    layerRows.splice(1, 0, {
      id: "quakes-live",
      label: "Quakes now",
      on: liveOn,
      kind: live.error ? null : "LIVE",
      count: liveOn ? (live.items?.length ?? null) : null,
      note: live.error ? "USGS did not answer. Recorded quakes still show." : null,
      onToggle: () => setLiveOn((v) => !v),
    });
  }

  const statKind: Stat["kind"] = SNAPSHOT_MODE ? "RECORDED" : "LIVE";
  const stats: Stat[] = [
    { label: "Quakes", value: counts.quakes, pending: "Loading", kind: statKind },
    { label: "Fire detections", value: counts.fires, pending: "Loading", kind: statKind },
    { label: "Aircraft", value: counts.flights, pending: "Loading", kind: statKind },
    {
      label: "Satellites",
      value: counts.satellites,
      pending: globeGo ? "Loading" : "With the globe",
      kind: statKind,
    },
  ];

  const onNav = (n: NavTarget) => {
    setNav(n);
    if (n === "sources") {
      select(null);
      setSourcesOpen(true);
      return;
    }
    setSourcesOpen(false);
    if (n === "brief") {
      setFeedMode("brief");
      focusPanel("panel-brief");
    } else if (n === "events") focusPanel("panel-events");
    else focusPanel("panel-replay");
  };

  const sources = (
    <SourcesRail
      visible={visible}
      onToggle={(id) => setVisible((v) => ({ ...v, [id]: !v[id] }))}
      status={status.data}
      statusError={status.error}
      counts={counts}
      recording={manifest ? { from: manifest.recordedFrom, to: manifest.windowTo } : null}
      spans={spans}
      live={
        SNAPSHOT_MODE
          ? {
              on: liveOn,
              onToggle: () => setLiveOn((v) => !v),
              count: live.items?.length ?? null,
              fetchedAt: live.fetchedAt,
              error: live.error,
            }
          : null
      }
    />
  );

  const sheet =
    selection !== null ? (
      <CitationSheet
        selection={selection}
        sentence={sentence}
        citations={citations.data}
        citationsLoading={citations.loading}
        citationsError={citations.error}
        onClose={() => select(null)}
      />
    ) : sourcesOpen ? (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex justify-end px-3 pt-3">
          <button
            type="button"
            onClick={() => setSourcesOpen(false)}
            aria-label="Close the sources"
            className="flex size-7 items-center justify-center rounded-full text-graphite hover:bg-white/10 hover:text-scratch"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="-mt-9 min-h-0 flex-1 overflow-y-auto">{sources}</div>
      </div>
    ) : null;

  const feed = (
    <FeedPanel
      brief={brief.data}
      briefLoading={brief.loading}
      briefError={brief.error}
      eventsById={briefById}
      replay={replay.data}
      from={from}
      to={to}
      t={time}
      mode={feedMode}
      onMode={setFeedMode}
      ask={ask}
      askPending={askPending}
      onAsk={onAsk}
      presets={SNAPSHOT_MODE ? (presets?.map((p) => p.question) ?? []) : null}
      selection={selection}
      onSelect={select}
    />
  );

  const statusPill =
    globeStatus !== "ready" && (globeGo || globeStatus !== "loading") ? (
      <p
        role={globeStatus === "loading" ? "status" : "alert"}
        className={`glass rounded-full px-3.5 py-1.5 text-center text-small ${globeStatus === "loading" ? "text-graphite" : "text-varnish"}`}
      >
        {GLOBE_MESSAGES[globeStatus]}
      </p>
    ) : null;

  const globeLayer = (
    <>
      {globeStatus !== "ready" && (
        // A still of the same view (scripts/capture-globe-still.ts), sized like Cesium sizes the
        // globe, so the swap to the live globe does not move it.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={GLOBE_STILL}
          alt=""
          aria-hidden="true"
          width={GLOBE_STILL_PX}
          height={GLOBE_STILL_PX}
          decoding="async"
          fetchPriority="high"
          className="argus-globe-still pointer-events-none absolute"
        />
      )}
      {globeGo && (
        <GlobeStage
          visible={visible}
          t={time}
          quakes={quakeItems}
          liveQuakes={live.items}
          liveQuakesVisible={liveOn}
          events={eventItems}
          fires={fireItems}
          flights={flightItems}
          satellites={satellites.data}
          highlightIds={highlight}
          track={track}
          focus={focus}
          reducedMotion={reducedMotion}
          creditRef={creditRef}
          onPick={onPick}
          onStatus={setGlobeStatus}
          onGlobe={setGlobe}
        />
      )}
      <div className="argus-vignette pointer-events-none absolute inset-0" />
      <GlobeHud globe={globe} active={selection !== null} compact={phone === true} />
    </>
  );

  const credits = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-graphite">
      <span>{visibleCredits.join(" · ")}</span>
      <div ref={creditRef} className="argus-cesium-credits flex items-center gap-2" />
      <Link href="/about" className="text-graphite underline hover:text-scratch">
        Full credits
      </Link>
    </div>
  );

  const strip =
    from !== null && to !== null ? (
      <ReplayStrip
        from={from}
        to={to}
        t={time}
        summary={replay.data}
        loading={replay.loading}
        error={replay.error}
        playing={playing}
        onSeek={(v) => {
          setPlaying(false);
          setFollowCited(false);
          setUserT(v);
        }}
        onTogglePlay={() => {
          if (!playing) {
            setUserT(to !== null && time >= to && from !== null ? from : time);
            setFollowCited(false);
          }
          setPlaying((v) => !v);
        }}
        pins={pins}
        activePin={selection?.from === "brief" ? selection.index + 1 : null}
        onSelectPin={(n) => select({ from: "brief", index: n - 1 })}
      />
    ) : (
      <p role="status" className="px-4 py-3 text-small text-graphite">
        {status.error ? `Replay unavailable: ${status.error}` : "Loading the last 24 hours"}
      </p>
    );

  const topBar = (
    <TopBar
      crumbs={[
        "Argus",
        "Earth",
        SNAPSHOT_MODE
          ? crumbLabel(replay.data ? { from: replay.data.from, to: replay.data.to } : null)
          : "Last 24 h",
      ]}
      t={to === null ? null : time}
      latencyMs={latency}
      alerts={brief.data?.brief?.bullets.length ?? null}
      onAlerts={() => onNav("brief")}
      presets={SNAPSHOT_MODE ? (presets?.map((p) => p.question) ?? []) : null}
      onAsk={onAsk}
      askPending={askPending}
      compact={phone === true}
    />
  );

  const rail = (
    <LeftRail
      nav={nav}
      onNav={onNav}
      layers={layerRows}
      replay={replay.data}
      from={from}
      to={to}
      t={time}
      compact={phone === true}
    />
  );

  const inspectorPanel = <InspectorPanel {...inspector} />;
  const statsPanel = (
    <StatsPanel
      stats={stats}
      t={to === null ? null : time}
      replay={replay.data}
      from={from}
      to={to}
    />
  );

  if (phone === null) {
    // The static HTML holds only the ground; the console renders once the viewport is known.
    return <main className="h-[calc(100dvh-32px)] bg-soot" aria-busy="true" />;
  }

  if (phone) {
    return (
      <main className="flex min-h-[calc(100dvh-32px)] flex-col gap-2.5 bg-soot p-2.5">
        {topBar}
        <div className="argus-globe-box relative h-[52dvh] min-h-[300px] shrink-0 overflow-hidden rounded-[18px] border border-white/[0.07] bg-soot">
          {globeLayer}
          {!globeGo && (
            <button
              type="button"
              onClick={() => setGlobeWanted(true)}
              className="glass absolute top-3 left-1/2 -translate-x-1/2 rounded-full px-3.5 py-1.5 text-small text-scratch"
            >
              Load the 3D globe
            </button>
          )}
          {statusPill && (
            <div className="absolute top-3 inset-x-3 flex justify-center">{statusPill}</div>
          )}
        </div>
        <div className="px-1">{credits}</div>
        {sheet && <div className="glass sheet-in flex max-h-[75dvh] min-h-0 flex-col">{sheet}</div>}
        <div className="glass h-[116px] shrink-0 overflow-hidden">{strip}</div>
        <div id="panel-brief" className="glass flex max-h-[80dvh] min-h-[360px] flex-col">
          {feed}
        </div>
        <div className="glass flex flex-col">{statsPanel}</div>
        <div className="glass flex min-h-[220px] flex-col">{inspectorPanel}</div>
        <div className="flex max-h-[640px] flex-col">{rail}</div>
      </main>
    );
  }

  return (
    <main className="relative h-[calc(100dvh-32px)] min-h-[640px] overflow-hidden bg-soot">
      <div className="argus-globe-box argus-globe-desk overflow-hidden">{globeLayer}</div>
      <div className="pointer-events-none absolute inset-0 grid grid-cols-[var(--rail-w)_minmax(0,1fr)] grid-rows-[var(--top-h)_minmax(0,1fr)_var(--panels-h)_var(--replay-h)] gap-[var(--pad)] p-[var(--pad)] [&>*]:pointer-events-auto">
        <div className="col-span-2">{topBar}</div>
        <div className="row-span-3 row-start-2 flex min-h-0 flex-col">{rail}</div>
        <div className="pointer-events-none! relative col-start-2 row-start-2 min-h-0">
          {statusPill && (
            <div className="absolute inset-x-0 bottom-16 flex justify-center">{statusPill}</div>
          )}
          {sheet && (
            <div className="glass sheet-in pointer-events-auto absolute top-0 right-0 bottom-0 flex w-[392px] flex-col overflow-hidden">
              {sheet}
            </div>
          )}
          <div
            className={`glass pointer-events-auto absolute top-0 w-[min(56%,640px)] rounded-[12px] px-3 py-1.5 ${sheet ? "left-0" : "right-0"}`}
          >
            {credits}
          </div>
        </div>
        <div className="col-start-2 row-start-3 grid min-h-0 grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)_minmax(0,1.2fr)] gap-[var(--pad)]">
          <div className="glass flex min-h-0 flex-col overflow-hidden">{inspectorPanel}</div>
          <div className="glass flex min-h-0 flex-col overflow-hidden">{statsPanel}</div>
          <div id="panel-brief" className="glass flex min-h-0 flex-col overflow-hidden">
            {feed}
          </div>
        </div>
        <div className="glass col-start-2 row-start-4 min-h-0 overflow-hidden">{strip}</div>
      </div>
    </main>
  );
}
