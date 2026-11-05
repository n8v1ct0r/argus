// Frame rate of the real app with every layer on (brief: "report the measured frame rate with all
// layers on"). Opens the app with ?instrument=1, waits until every data layer is mounted and the
// imagery has loaded, samples 5 s of continuous rendering, and prints the mean, the 5th percentile,
// the GPU, and the items drawn per layer. Reports only; it sets no pass mark.
//
//   pnpm build && pnpm start --port 3100      (another terminal, against a seeded database)
//   node scripts/measure-fps.ts [http://localhost:3100]
import type { FrameRateSample, Globe, LayerStat } from "@argus/globe";
import { chromium } from "@playwright/test";

const LAYERS = ["quakes", "events", "fires", "flights", "satellites"];
const SAMPLE_MS = 5000;

type Instrumented = Window & { __argusGlobe?: Globe };

const url = new URL("/?instrument=1", process.argv[2] ?? "http://localhost:3100");
// Real Chrome headless uses the GPU on macOS; the default headless shell would fall back to
// SwiftShader and understate the frame rate (same choice as the e2e project).
const browser = await chromium.launch({ channel: "chromium" });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(url.href);
  await page.waitForFunction(
    (ids) => {
      const g = (window as Instrumented).__argusGlobe;
      if (!g) return false;
      const stats = g.layerStats();
      return ids.every((id) => id in stats);
    },
    LAYERS,
    { timeout: 90_000 },
  );
  const result = await page.evaluate(async (ms) => {
    const g = (window as Instrumented).__argusGlobe;
    if (!g) throw new Error("the globe handle is missing");
    const tiles = await g.whenTilesLoaded(30_000);
    const fps: FrameRateSample = await g.sampleFrameRate(ms, { forceContinuous: true });
    const gl = document.createElement("canvas").getContext("webgl2");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const gpu = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown";
    return { tiles, fps, gpu, stats: g.layerStats() as Record<string, LayerStat> };
  }, SAMPLE_MS);

  console.log(`url: ${url.href}`);
  console.log(`gpu: ${result.gpu}`);
  console.log(`imagery tiles loaded: ${result.tiles}`);
  for (const [id, s] of Object.entries(result.stats).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`layer ${id}: ${s.items} items, ${s.visible ? "visible" : "hidden"}`);
  }
  const { mean, p5, frames, ms } = result.fps;
  console.log(
    `frame rate: mean ${mean.toFixed(1)} fps, p5 ${p5.toFixed(1)} fps, ${frames} frames in ${Math.round(ms)} ms`,
  );
  if (pageErrors.length) console.log(`page errors: ${pageErrors.join(" | ")}`);
} finally {
  await browser.close();
}
