// The Cesium implementation behind createGlobe(). Receives the runtime Cesium namespace from
// runtime.ts; only type imports from "cesium" appear here, so no bundler ever compiles Cesium.
import type { Cartesian2, Cartesian3 } from "cesium";
import * as cam from "./camera.ts";
import { sampleFrameRate } from "./fps.ts";
import { gibsDayLayer, naturalEarthLayer, nightLayer } from "./imagery.ts";
import {
  cssColor,
  mountLayer,
  setMountedVisible,
  unmountLayer,
  type MountedLayer,
} from "./layers.ts";
import type { Cesium } from "./runtime.ts";
import type { Globe, GlobeOptions, LayerData, LayerStat, PickHit } from "./types.ts";

const HIGHLIGHT_PX = 22;
// The "ping" when items are highlighted: rings that grow out of each highlighted item and fade.
// Skipped under reduced motion; the static ring stays either way.
const PING_PERIOD_MS = 900;
const PING_COUNT = 4;
const PING_GROW = 3.2;

// The "dots" surface: a screen-space grid of dots over the grayscale imagery. Between the dots
// the globe is near black, so the planet reads as a point cloud and the data glyphs stay clear.
const DOT_PITCH_PX = 3.0;
const DOTS_SOURCE = `
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material m = czm_getDefaultMaterial(materialInput);
  float pitch = pitchPx * czm_pixelRatio;
  vec2 cell = mod(gl_FragCoord.xy, pitch) - 0.5 * pitch;
  float r = length(cell) / czm_pixelRatio;
  float dotMask = 1.0 - smoothstep(0.55, 1.05, r);
  m.diffuse = gap.rgb;
  m.alpha = (1.0 - dotMask) * gap.a;
  return m;
}`;

export function createGlobeImpl(C: Cesium, container: HTMLElement, options: GlobeOptions): Globe {
  // Argus uses no Cesium ion services. A blank token makes any accidental ion call fail loudly
  // instead of silently using the bundled evaluation token (which expires 2026-11-01).
  C.Ion.defaultAccessToken = "";
  let reducedMotion = options.reducedMotion ?? false;

  const widget = new C.CesiumWidget(container, {
    baseLayer: naturalEarthLayer(C),
    terrainProvider: new C.EllipsoidTerrainProvider(),
    creditContainer: options.creditContainer,
    requestRenderMode: true,
    maximumRenderTimeChange: Number.POSITIVE_INFINITY,
    shouldAnimate: false,
    useBrowserRecommendedResolution: true,
    // The host shows its own message on failure (GlobeOptions.onRenderError, or the rejected
    // createGlobe), not Cesium's panel.
    showRenderLoopErrors: false,
  });
  const { scene, camera } = widget;
  scene.renderError.addEventListener((_scene: unknown, error: unknown) =>
    options.onRenderError?.(error),
  );
  scene.globe.baseColor = cssColor(C, options.theme.base);
  scene.globe.enableLighting = true;
  scene.backgroundColor = cssColor(C, options.theme.base);
  if (scene.moon) scene.moon.show = false;

  const dots = options.surface === "dots";
  if ((options.imagery ?? "gibs") === "gibs") {
    const day = gibsDayLayer(C, options.imageryCredits?.gibs);
    if (dots) {
      day.saturation = 0;
      day.contrast = 1.25;
      day.brightness = 1.9;
      day.gamma = 0.75;
    }
    scene.imageryLayers.add(day);
  }
  if (options.nightImageUrl) {
    scene.imageryLayers.add(
      nightLayer(
        C,
        options.nightImageUrl,
        options.nightBrightness ?? 2.2,
        options.imageryCredits?.night,
      ),
    );
  }

  if (dots) {
    const base = scene.imageryLayers.get(0);
    if (base) base.saturation = 0;
    const night =
      scene.imageryLayers.length > 1
        ? scene.imageryLayers.get(scene.imageryLayers.length - 1)
        : null;
    if (night && options.nightImageUrl) night.saturation = 0;
    scene.globe.showGroundAtmosphere = false;
    if (scene.skyAtmosphere) {
      scene.skyAtmosphere.saturationShift = -1;
      scene.skyAtmosphere.brightnessShift = -0.55;
    }
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.sun) scene.sun.show = false;
    scene.globe.material = new C.Material({
      fabric: {
        type: "ArgusDots",
        uniforms: { pitchPx: DOT_PITCH_PX, gap: cssColor(C, options.theme.base).withAlpha(0.9) },
        source: DOTS_SOURCE,
      },
      translucent: false,
    });
  }

  const applyMotion = () => {
    const c = scene.screenSpaceCameraController;
    c.inertiaSpin = reducedMotion ? 0 : 0.9;
    c.inertiaTranslate = reducedMotion ? 0 : 0.9;
    c.inertiaZoom = reducedMotion ? 0 : 0.8;
  };
  applyMotion();
  if (options.initialCamera) cam.setCamera(C, camera, options.initialCamera);

  const layers = new Map<string, MountedLayer>();
  const highlightColl = new C.PointPrimitiveCollection();
  scene.primitives.add(highlightColl);
  const pingColl = new C.PointPrimitiveCollection();
  scene.primitives.add(pingColl);
  let pingFrame = 0;
  const stopPing = () => {
    if (pingFrame) cancelAnimationFrame(pingFrame);
    pingFrame = 0;
    pingColl.removeAll();
  };
  const startPing = (positions: Cartesian3[], css: string) => {
    stopPing();
    if (reducedMotion || !positions.length) return;
    const base = cssColor(C, css);
    const points = positions.map((position) =>
      pingColl.add({
        position,
        color: C.Color.TRANSPARENT,
        pixelSize: HIGHLIGHT_PX,
        outlineColor: base,
        outlineWidth: 2,
      }),
    );
    const started = performance.now();
    const step = (now: number) => {
      const elapsed = now - started;
      if (elapsed >= PING_PERIOD_MS * PING_COUNT) {
        stopPing();
        scene.requestRender();
        return;
      }
      const phase = (elapsed % PING_PERIOD_MS) / PING_PERIOD_MS;
      for (const pt of points) {
        pt.pixelSize = HIGHLIGHT_PX * (1 + (PING_GROW - 1) * phase);
        pt.outlineColor = base.withAlpha(1 - phase);
      }
      scene.requestRender();
      pingFrame = requestAnimationFrame(step);
    };
    pingFrame = requestAnimationFrame(step);
  };

  const pickListeners = new Set<(hit: PickHit | null) => void>();
  const handler = new C.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction((e: { position: Cartesian2 }) => {
    const picked = scene.pick(e.position) as { id?: unknown } | undefined;
    const id = picked?.id as PickHit | undefined;
    const hit =
      id && typeof id === "object" && "layerId" in id && "id" in id
        ? { layerId: id.layerId, id: id.id }
        : null;
    for (const cb of pickListeners) cb(hit);
  }, C.ScreenSpaceEventType.LEFT_CLICK);

  const render = () => scene.requestRender();

  // Camera listeners, called at most once per frame while the camera moves.
  const cameraListeners = new Set<(state: ReturnType<typeof cam.getCamera>) => void>();
  camera.percentageChanged = 0.001;
  let cameraFrame = 0;
  const emitCamera = () => {
    if (cameraFrame || !cameraListeners.size) return;
    cameraFrame = requestAnimationFrame(() => {
      cameraFrame = 0;
      const state = cam.getCamera(C, camera);
      for (const cb of cameraListeners) cb(state);
    });
  };
  const offChanged = camera.changed.addEventListener(emitCamera);
  const offMoveEnd = camera.moveEnd.addEventListener(emitCamera);

  return {
    setLayer(id: string, data: LayerData) {
      const old = layers.get(id);
      const visible = old ? old.handle.show : true;
      if (old) unmountLayer(scene, old);
      const mounted = mountLayer(C, scene, id, data, options.theme);
      setMountedVisible(mounted, visible);
      layers.set(id, mounted);
      scene.primitives.raiseToTop(highlightColl);
      scene.primitives.raiseToTop(pingColl);
      render();
    },
    removeLayer(id: string) {
      const old = layers.get(id);
      if (!old) return;
      unmountLayer(scene, old);
      layers.delete(id);
      render();
    },
    setLayerVisible(id: string, visible: boolean) {
      const l = layers.get(id);
      if (l) setMountedVisible(l, visible);
      render();
    },
    setTime(t: Date) {
      widget.clock.currentTime = C.JulianDate.fromDate(t);
      render();
    },
    flyTo(target, opts) {
      return cam
        .flyTo(C, camera, target, opts?.reducedMotion ?? reducedMotion, opts?.minSpanDeg)
        .then(render);
    },
    highlight(ids: string[]) {
      highlightColl.removeAll();
      const ink = cssColor(C, options.theme.highlight);
      const lit: Cartesian3[] = [];
      for (const want of ids) {
        let found: Cartesian3 | undefined;
        for (const l of layers.values()) {
          found = l.index.get(want);
          if (found) break;
        }
        if (!found) continue;
        lit.push(found);
        highlightColl.add({
          position: found,
          color: C.Color.TRANSPARENT,
          pixelSize: HIGHLIGHT_PX,
          outlineColor: ink,
          outlineWidth: 3,
        });
      }
      startPing(lit, options.theme.highlight);
      render();
    },
    onPick(cb) {
      pickListeners.add(cb);
      return () => pickListeners.delete(cb);
    },
    layerStats() {
      const stats: Record<string, LayerStat> = {};
      for (const [id, l] of layers) stats[id] = { items: l.index.size, visible: l.handle.show };
      return stats;
    },
    getCamera: () => cam.getCamera(C, camera),
    onCameraChange(cb) {
      cameraListeners.add(cb);
      cb(cam.getCamera(C, camera));
      return () => cameraListeners.delete(cb);
    },
    setCamera(state) {
      cam.setCamera(C, camera, state);
      render();
    },
    setReducedMotion(on: boolean) {
      reducedMotion = on;
      applyMotion();
    },
    whenTilesLoaded(timeoutMs = 20000) {
      return new Promise((resolve) => {
        if (scene.globe.tilesLoaded) return resolve(true);
        const started = performance.now();
        const check = () => {
          if (scene.globe.tilesLoaded) {
            scene.postRender.removeEventListener(check);
            resolve(true);
          } else if (performance.now() - started > timeoutMs) {
            scene.postRender.removeEventListener(check);
            resolve(false);
          } else {
            render();
          }
        };
        scene.postRender.addEventListener(check);
        render();
      });
    },
    sampleFrameRate: (ms, opts) => sampleFrameRate(scene, ms, opts),
    destroy() {
      stopPing();
      if (cameraFrame) cancelAnimationFrame(cameraFrame);
      cameraListeners.clear();
      offChanged();
      offMoveEnd();
      pickListeners.clear();
      handler.destroy();
      widget.destroy();
    },
  };
}
