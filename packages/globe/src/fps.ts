import type { Scene } from "cesium";
import type { FrameRateSample } from "./types.ts";

/**
 * Measures real rendering capacity. With forceContinuous (the default), request-render mode is
 * switched off for the sample so idle frames are not mistaken for capacity, then restored.
 */
export function sampleFrameRate(
  scene: Scene,
  ms: number,
  opts: { forceContinuous?: boolean } = {},
): Promise<FrameRateSample> {
  const force = opts.forceContinuous ?? true;
  const previousMode = scene.requestRenderMode;
  if (force) scene.requestRenderMode = false;

  const stamps: number[] = [];
  const onRender = () => stamps.push(performance.now());
  scene.postRender.addEventListener(onRender);
  scene.requestRender();

  return new Promise((resolve) => {
    setTimeout(() => {
      scene.postRender.removeEventListener(onRender);
      scene.requestRenderMode = previousMode;
      const rates: number[] = [];
      for (let i = 1; i < stamps.length; i++) {
        const dt = (stamps[i] ?? 0) - (stamps[i - 1] ?? 0);
        if (dt > 0) rates.push(1000 / dt);
      }
      rates.sort((a, b) => a - b);
      const elapsed = stamps.length > 1 ? (stamps[stamps.length - 1] ?? 0) - (stamps[0] ?? 0) : ms;
      resolve({
        mean: stamps.length > 1 ? ((stamps.length - 1) * 1000) / elapsed : 0,
        p5: rates.length ? (rates[Math.floor(rates.length * 0.05)] ?? 0) : 0,
        frames: stamps.length,
        ms: elapsed,
      });
    }, ms);
  });
}
