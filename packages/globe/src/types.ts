// Public contract of @argus/globe. Plain data in, no Cesium types out, so a host app
// (Argus, Kratos) never imports Cesium to drive the globe.

/** [longitude, latitude] in WGS84 degrees. */
export type LonLat = [number, number];

export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** CSS color string, for example "#ECE9E2" or "rgba(236,233,226,0.6)". */
export type Color = string;

interface LayerBase {
  /** Stable ids, one per item, returned by picking and used by highlight(). */
  ids: string[];
  /** Default color for every item. */
  color?: Color;
  /** Optional per-item colors, same length as ids. Overrides `color`. */
  colors?: Color[];
}

/** Dots: satellites. positions = [lon, lat, heightMeters] triples. */
export interface PointLayer extends LayerBase {
  kind: "points";
  positions: Float64Array;
  pixelSize?: number;
}

/** Heading-rotated chevrons: flights. rotationsDeg are compass headings (0 = north). */
export interface ChevronLayer extends LayerBase {
  kind: "chevrons";
  positions: Float64Array;
  rotationsDeg: Float32Array;
  sizePx?: number;
}

/** Hollow rings sized per item: earthquakes. */
export interface RingLayer extends LayerBase {
  kind: "rings";
  positions: Float64Array;
  diametersPx: Float32Array;
  strokePx?: number;
}

/** Hatched rectangles: fire cells. rects = [west, south, east, north] quadruples in degrees. */
export interface AreaLayer extends LayerBase {
  kind: "areas";
  rects: Float64Array;
}

/** Open polylines: event tracks. Each path is [lon, lat, lon, lat, ...]. */
export interface PathLayer extends LayerBase {
  kind: "paths";
  paths: Float64Array[];
  widthPx?: number;
}

export type LayerData = PointLayer | ChevronLayer | RingLayer | AreaLayer | PathLayer;

export interface CameraState {
  lon: number;
  lat: number;
  heightMeters: number;
  headingDeg: number;
  pitchDeg: number;
}

export interface PickHit {
  layerId: string;
  id: string;
}

/** One mounted layer, as layerStats() reports it. */
export interface LayerStat {
  /** Items drawn (one per id passed to setLayer). */
  items: number;
  visible: boolean;
}

export interface FrameRateSample {
  /** Frames rendered divided by elapsed seconds. */
  mean: number;
  /** 5th percentile of per-frame rates (1000 / frame interval in ms). */
  p5: number;
  frames: number;
  ms: number;
}

export interface GlobeTheme {
  /** Ink for cited or selected items. */
  highlight: Color;
  /** Thin outline behind every glyph so it reads over bright imagery. */
  halo: Color;
  /** Globe color shown before imagery loads. */
  base: Color;
}

export interface GlobeOptions {
  /** Element that receives Cesium's own credits (logo and imagery credits). Must stay visible. */
  creditContainer: HTMLElement;
  /**
   * Called when rendering fails after the globe started; it then stops drawing. Cesium's own
   * error panel is off, so the host shows the message.
   */
  onRenderError?: (error: unknown) => void;
  /** Where public/cesium assets are served. Default "/cesium". */
  baseUrl?: string;
  /** "gibs": NASA GIBS day tiles over Natural Earth. "offline": Natural Earth only (deterministic). */
  imagery?: "gibs" | "offline";
  /** Self-hosted equirectangular night-lights image. Omit to skip the night layer. */
  nightImageUrl?: string;
  /** Brightness multiplier for the night layer (Cesium dims the night side). Default 2.2. */
  nightBrightness?: number;
  reducedMotion?: boolean;
  /**
   * On-screen imagery credits. Defaults are NASA's full acknowledgment sentences; a host with
   * little space may pass shorter credits and show the full text elsewhere (an about page).
   */
  imageryCredits?: { gibs?: string; night?: string };
  initialCamera?: CameraState;
  theme: GlobeTheme;
  /**
   * "dots": the imagery in grayscale, seen through a screen-space grid of dots, like a point
   * cloud. Data glyphs draw on top at full strength. Default "imagery" (the imagery as is).
   */
  surface?: "imagery" | "dots";
}

export interface Globe {
  setLayer(id: string, data: LayerData): void;
  removeLayer(id: string): void;
  setLayerVisible(id: string, visible: boolean): void;
  /** Sets the clock; the day/night terminator follows. */
  setTime(t: Date): void;
  flyTo(
    target: { points?: LonLat[]; bbox?: BBox },
    /** minSpanDeg: the narrowest view in degrees (default 18), so 1 point keeps its context. */
    opts?: { reducedMotion?: boolean; minSpanDeg?: number },
  ): Promise<void>;
  /** Draws highlight rings on the items with these ids (any layer). Empty array clears. */
  highlight(ids: string[]): void;
  onPick(cb: (hit: PickHit | null) => void): () => void;
  getCamera(): CameraState;
  /** Called (at most once per frame) while the camera moves. Returns an unsubscribe function. */
  onCameraChange(cb: (state: CameraState) => void): () => void;
  setCamera(state: CameraState): void;
  setReducedMotion(on: boolean): void;
  /** Resolves when every imagery tile for the current view has loaded. */
  whenTilesLoaded(timeoutMs?: number): Promise<boolean>;
  sampleFrameRate(ms: number, opts?: { forceContinuous?: boolean }): Promise<FrameRateSample>;
  /** Items and visibility per mounted layer id, for instrumentation and tests. */
  layerStats(): Record<string, LayerStat>;
  destroy(): void;
}
