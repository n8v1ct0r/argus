"use client";
// Feeds API data into @argus/globe. Owns no data; reacts to props.
import type { Globe, LonLat } from "@argus/globe";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type RefObject } from "react";
import type {
  FireCellItem,
  FlightItem,
  LayerId,
  NaturalEventItem,
  QuakeItem,
  SatelliteGrid,
} from "../api/types.ts";
import type { LiveQuake } from "../snapshot/live-usgs.ts";
import { positionsAt } from "./satellites-interp.ts";

const GlobeView = dynamic(() => import("@argus/globe/react").then((m) => m.GlobeView), {
  ssr: false,
});

const INK = {
  scratch: "#F2F3F5",
  graphite: "#A3A8B0",
  // The one accent: detector findings, cited events, and the cited track.
  signal: "#FF8A3D",
  pen: "#FF8A3D",
  soot: "#050607",
  fireCell: "rgba(242,243,245,0.3)",
  // While a citation is open, uncited fire cells step back so the cited events read first.
  fireCellQuiet: "rgba(242,243,245,0.1)",
  // The honesty strip's LIVE green: quakes fetched from USGS by the browser now.
  live: "#3DDC84",
};

/** The globe's state: loading, drawing, or failed to start or while drawing (WebGL problems). */
export type GlobeStatus = "loading" | "ready" | "start-failed" | "render-failed";

/** The window as instrumented runs see it (?instrument=1). */
export type InstrumentedWindow = Window & { __argusGlobe?: Globe };

/** A new object (even with the same points) re-runs the camera flight. */
export interface GlobeFocus {
  points: LonLat[];
  /** The narrowest view in degrees; a short aircraft track needs a closer view than a quake. */
  minSpanDeg?: number;
}

export interface GlobeStageProps {
  visible: Record<LayerId, boolean>;
  t: number;
  quakes: QuakeItem[] | null;
  /** Static deploy only: quakes from the live USGS feed, drawn at every replay time. */
  liveQuakes?: LiveQuake[] | null;
  liveQuakesVisible?: boolean;
  events: NaturalEventItem[] | null;
  fires: FireCellItem[] | null;
  flights: FlightItem[] | null;
  satellites: SatelliteGrid | null;
  highlightIds: string[];
  track: { id: string; path: LonLat[] } | null;
  focus: GlobeFocus | null;
  reducedMotion: boolean;
  creditRef: RefObject<HTMLDivElement | null>;
  onPick: (layerId: string, id: string) => void;
  onStatus: (status: GlobeStatus) => void;
  /** The globe handle once it draws, for the HUD's camera readouts. */
  onGlobe?: (globe: Globe) => void;
}

const TOUR_MAX_STOPS = 8;
const TOUR_DWELL_MS = 1100;
const SPREAD_LON_DEG = 90;
const SPREAD_LAT_DEG = 60;

/** True when the points cannot share one view of the globe. */
function isSpread(points: LonLat[]): boolean {
  if (points.length < 2) return false;
  const lons = points.map((q) => q[0]);
  const lats = points.map((q) => q[1]);
  return (
    Math.max(...lons) - Math.min(...lons) > SPREAD_LON_DEG ||
    Math.max(...lats) - Math.min(...lats) > SPREAD_LAT_DEG
  );
}

/** West to east, so the tour sweeps around the globe instead of zigzagging. */
function tourOrder(points: LonLat[]): LonLat[] {
  const seen = new Set<string>();
  return [...points]
    .sort((a, b) => a[0] - b[0])
    .filter((q) => {
      const key = `${q[0].toFixed(1)},${q[1].toFixed(1)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function magDiameter(mag: number): number {
  return Math.max(6, 6 + mag * 3);
}

export function GlobeStage(p: GlobeStageProps) {
  const globeRef = useRef<Globe | null>(null);
  const [ready, setReady] = useState(false);
  const onPickRef = useRef(p.onPick);
  const onStatusRef = useRef(p.onStatus);
  const onGlobeRef = useRef(p.onGlobe);
  useEffect(() => {
    onPickRef.current = p.onPick;
    onStatusRef.current = p.onStatus;
    onGlobeRef.current = p.onGlobe;
  }, [p.onPick, p.onStatus, p.onGlobe]);

  // Quakes up to the replay time; detector findings in Signal.
  useEffect(() => {
    const g = globeRef.current;
    if (!g || !ready || !p.quakes) return;
    const items = p.quakes.filter((q) => q.occurredAt <= p.t);
    g.setLayer("quakes", {
      kind: "rings",
      ids: items.map((q) => q.id),
      positions: new Float64Array(items.flatMap((q) => [q.lon, q.lat, 0])),
      diametersPx: new Float32Array(items.map((q) => magDiameter(q.magValue))),
      colors: items.map((q) => (q.inFinding ? INK.signal : INK.scratch)),
      strokePx: 1.5,
    });
  }, [ready, p.quakes, p.t]);

  // Live quakes are not part of the recording, so the replay time does not filter them.
  useEffect(() => {
    const g = globeRef.current;
    if (!g || !ready) return;
    const items = p.liveQuakes ?? [];
    if (!items.length) {
      g.removeLayer("quakes-live");
      return;
    }
    g.setLayer("quakes-live", {
      kind: "rings",
      ids: items.map((q) => `usgs-live:${q.id}`),
      positions: new Float64Array(items.flatMap((q) => [q.lon, q.lat, 0])),
      diametersPx: new Float32Array(items.map((q) => magDiameter(q.mag ?? 0))),
      colors: items.map(() => INK.live),
      strokePx: 1.5,
    });
    g.setLayerVisible("quakes-live", p.liveQuakesVisible ?? true);
  }, [ready, p.liveQuakes, p.liveQuakesVisible]);

  useEffect(() => {
    const g = globeRef.current;
    if (!g || !ready || !p.events) return;
    const items = p.events.filter((e) => e.occurredAt <= p.t);
    g.setLayer("events", {
      kind: "points",
      ids: items.map((e) => e.id),
      positions: new Float64Array(items.flatMap((e) => [e.lon, e.lat, 0])),
      color: INK.scratch,
      pixelSize: 8,
    });
  }, [ready, p.events, p.t]);

  useEffect(() => {
    const g = globeRef.current;
    if (!g || !ready || !p.fires) return;
    const citing = p.highlightIds.length > 0;
    const plain = p.fires.filter((c) => !c.inFinding);
    const found = p.fires.filter((c) => c.inFinding);
    const rects = (cells: FireCellItem[]) =>
      new Float64Array(cells.flatMap((c) => [c.lon, c.lat, c.lon + 1, c.lat + 1]));
    g.setLayer("fires", {
      kind: "areas",
      ids: plain.map((c) => c.id),
      rects: rects(plain),
      color: citing ? INK.fireCellQuiet : INK.fireCell,
    });
    g.setLayer("fires-finding", {
      kind: "areas",
      ids: found.map((c) => c.id),
      rects: rects(found),
      color: INK.signal,
    });
  }, [ready, p.fires, p.highlightIds]);

  useEffect(() => {
    const g = globeRef.current;
    if (!g || !ready || !p.flights) return;
    const items = p.flights;
    g.setLayer("flights", {
      kind: "chevrons",
      ids: items.map((f) => f.id),
      positions: new Float64Array(items.flatMap((f) => [f.lon, f.lat, (f.altFt ?? 0) * 0.3048])),
      rotationsDeg: new Float32Array(items.map((f) => f.trackDeg ?? 0)),
      color: INK.scratch,
      sizePx: 12,
    });
  }, [ready, p.flights]);

  useEffect(() => {
    const g = globeRef.current;
    if (!g || !ready || !p.satellites) return;
    const { ids, positions } = positionsAt(p.satellites, p.t);
    g.setLayer("satellites", { kind: "points", ids, positions, color: INK.graphite, pixelSize: 3 });
  }, [ready, p.satellites, p.t]);

  // Visibility, including the finding sub-layer of fires.
  useEffect(() => {
    const g = globeRef.current;
    if (!g || !ready) return;
    for (const [id, on] of Object.entries(p.visible)) g.setLayerVisible(id, on);
    g.setLayerVisible("fires-finding", p.visible.fires);
  }, [ready, p.visible, p.quakes, p.events, p.fires, p.flights, p.satellites]);

  useEffect(() => {
    const g = globeRef.current;
    if (!g || !ready) return;
    g.setTime(new Date(p.t));
  }, [ready, p.t]);

  useEffect(() => {
    const g = globeRef.current;
    if (!g || !ready) return;
    if (p.track && p.track.path.length > 1) {
      g.setLayer("track", {
        kind: "paths",
        ids: [p.track.id],
        paths: [new Float64Array(p.track.path.flat())],
        color: INK.pen,
        widthPx: 2,
      });
    } else {
      g.removeLayer("track");
    }
  }, [ready, p.track]);

  useEffect(() => {
    const g = globeRef.current;
    if (!g || !ready) return;
    g.highlight(p.highlightIds);
  }, [ready, p.highlightIds, p.quakes, p.fires, p.events]);

  // One flight frames the cited events. Events spread too wide to frame together (a count of
  // quakes around the world) get a tour instead: a flight to each, with a fresh ping at each stop.
  const highlightRef = useRef(p.highlightIds);
  useEffect(() => {
    highlightRef.current = p.highlightIds;
  }, [p.highlightIds]);
  useEffect(() => {
    const g = globeRef.current;
    if (!g || !ready || !p.focus || !p.focus.points.length) return;
    const points = p.focus.points;
    if (p.reducedMotion || !isSpread(points)) {
      void g.flyTo({ points }, { reducedMotion: p.reducedMotion, minSpanDeg: p.focus.minSpanDeg });
      return;
    }
    let cancelled = false;
    void (async () => {
      for (const point of tourOrder(points).slice(0, TOUR_MAX_STOPS)) {
        if (cancelled) return;
        await g.flyTo({ points: [point] }, { reducedMotion: false });
        if (cancelled) return;
        g.highlight(highlightRef.current);
        await new Promise((r) => setTimeout(r, TOUR_DWELL_MS));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, p.focus, p.reducedMotion]);

  useEffect(() => {
    globeRef.current?.setReducedMotion(p.reducedMotion);
  }, [p.reducedMotion]);

  return (
    <GlobeView
      className="absolute inset-0"
      creditContainerRef={p.creditRef}
      options={{
        imagery: "gibs",
        nightImageUrl: "/imagery/black-marble/black-marble-2016-4096.webp",
        imageryCredits: { gibs: "Imagery: NASA GIBS", night: "Night lights: NASA Black Marble" },
        onRenderError: (err) => {
          console.warn("Argus: the globe stopped drawing.", err);
          onStatusRef.current("render-failed");
        },
        theme: { highlight: INK.pen, halo: INK.soot, base: INK.soot },
        surface: "dots",
        reducedMotion: p.reducedMotion,
        initialCamera: {
          lon: -40,
          lat: 28,
          heightMeters: 21_000_000,
          headingDeg: 0,
          pitchDeg: -90,
        },
      }}
      onReady={(g) => {
        globeRef.current = g;
        // ?instrument=1 exposes the handle to scripts/measure-fps.ts and the e2e tests.
        if (new URLSearchParams(window.location.search).get("instrument") === "1") {
          (window as InstrumentedWindow).__argusGlobe = g;
        }
        g.onPick((hit) => {
          if (hit) onPickRef.current(hit.layerId, hit.id);
        });
        setReady(true);
        onStatusRef.current("ready");
        onGlobeRef.current?.(g);
      }}
      onError={(err) => {
        // The detail goes to the console for debugging; the page shows plain copy.
        console.warn("Argus: the globe could not start.", err);
        onStatusRef.current("start-failed");
      }}
    />
  );
}
