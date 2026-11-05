// @argus/globe: a framework-free CesiumJS globe. The host passes plain data and gets a small
// handle back; Cesium types never leave this package, and Cesium itself loads at runtime from
// the host's copy of Cesium's prebuilt bundle (see runtime.ts).
export type {
  AreaLayer,
  BBox,
  CameraState,
  ChevronLayer,
  Color,
  FrameRateSample,
  Globe,
  GlobeOptions,
  GlobeTheme,
  LayerData,
  LayerStat,
  LonLat,
  PathLayer,
  PickHit,
  PointLayer,
  RingLayer,
} from "./types.ts";
export { BLACK_MARBLE_CREDIT, GIBS_CREDIT } from "./credits.ts";

import { createGlobeImpl } from "./globe.ts";
import { loadCesium } from "./runtime.ts";
import type { Globe, GlobeOptions } from "./types.ts";

/**
 * Creates the globe inside `container`. Loads `${baseUrl}/Cesium.js` (default "/cesium") once,
 * which also makes Cesium's workers and assets resolve from that path.
 */
export async function createGlobe(container: HTMLElement, options: GlobeOptions): Promise<Globe> {
  const C = await loadCesium(options.baseUrl ?? "/cesium");
  return createGlobeImpl(C, container, options);
}
