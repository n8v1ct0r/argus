// The still of Earth the page shows while Cesium loads (public/imagery/globe-still.webp). Opens
// the app with ?instrument=1, turns every data layer off, hides the panels over the globe, waits
// for the imagery, and crops the
// globe at the start view: a square of 1.08 times the disc, centered, with the corners outside
// the atmosphere made transparent. Rerun it after a new snapshot export: the lit side follows the
// recording's end time.
//
//   ARGUS_MODE=snapshot pnpm build && pnpm start --port 3100      (another terminal)
//   node scripts/capture-globe-still.ts [http://localhost:3100]
import type { Globe } from "@argus/globe";
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const LAYERS = [
  "quakes",
  "quakes-live",
  "events",
  "fires",
  "fires-finding",
  "flights",
  "satellites",
];
// Cesium's 60 degree field of view spans the canvas's longer side; from 21,000 km the disc is
// 41.45% of it (2 * tan(asin(6371 / 27371)) / (2 * tan(30 deg))). Keep in step with globals.css.
const DISC = 0.4145;
const CROP = 1.08;
const OUT_PX = 640;

type Instrumented = Window & { __argusGlobe?: Globe };

const url = new URL("/?instrument=1", process.argv[2] ?? "http://localhost:3100");
const browser = await chromium.launch({ channel: "chromium" });
try {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1200 },
    deviceScaleFactor: 2,
  });
  await page.goto(url.href);
  await page.waitForFunction(
    (ids) => {
      const g = (window as Instrumented).__argusGlobe;
      return Boolean(g && ids.every((id) => id in g.layerStats()));
    },
    ["quakes", "events", "fires", "flights", "satellites"],
    { timeout: 90_000 },
  );
  const hide = () =>
    page.evaluate(async (ids) => {
      const g = (window as Instrumented).__argusGlobe!;
      for (const id of ids) g.setLayerVisible(id, false);
      g.highlight([]);
      await g.whenTilesLoaded(30_000);
    }, LAYERS);
  await hide();
  await page.waitForTimeout(1500);
  await hide();
  // Only the globe itself: no panels, HUD, or vignette over it.
  await page.addStyleTag({
    content:
      "main > *:not(.argus-globe-box), .argus-hud, .argus-vignette { visibility: hidden !important; }",
  });
  await page.waitForTimeout(300);

  const box = await page.locator(".argus-globe-box canvas").first().boundingBox();
  if (!box) throw new Error("the globe canvas is missing");
  const side = Math.round(Math.max(box.width, box.height) * DISC * CROP);
  const shot = await page.screenshot({
    clip: {
      x: box.x + (box.width - side) / 2,
      y: box.y + (box.height - side) / 2,
      width: side,
      height: side,
    },
  });
  const dataUrl = await page.evaluate(
    async ({ b64, px }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = px;
      c.height = px;
      const ctx = c.getContext("2d")!;
      ctx.beginPath();
      ctx.arc(px / 2, px / 2, px / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, 0, 0, px, px);
      return c.toDataURL("image/webp", 0.72);
    },
    { b64: shot.toString("base64"), px: OUT_PX },
  );
  const out = join(process.cwd(), "public", "imagery", "globe-still.webp");
  const bytes = Buffer.from(dataUrl.split(",")[1]!, "base64");
  writeFileSync(out, bytes);
  console.log(`wrote ${out}: ${bytes.length} bytes, ${OUT_PX} px, crop ${side} css px`);
} finally {
  await browser.close();
}
