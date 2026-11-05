// The main flow of the static deploy: the honesty strip, then a brief sentence that flies the
// globe to its cited events and opens their stored records. Runs against `pnpm start` on a build
// made with ARGUS_MODE=snapshot (see README, "Static deploy").
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReplaySummary } from "../../src/api/types.ts";
import type { InstrumentedWindow } from "../../src/components/GlobeStage.tsx";
import { crumbLabel, layerSpans, spanLabel } from "../../src/snapshot/windows.ts";

test("brief sentence flies the globe to its cited event and opens the citation", async ({
  page,
}) => {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") problems.push(m.text());
  });
  await page.goto("/?instrument=1");

  const strip = page.locator("[data-honesty-strip]");
  await expect(strip).toBeVisible();
  await expect(strip).toContainText("DEMO");
  await expect(strip).toContainText("SIDEQUEST 01");

  await page.waitForFunction(() => Boolean((window as InstrumentedWindow).__argusGlobe), null, {
    timeout: 60_000,
  });
  const before = await page.evaluate(() =>
    (window as InstrumentedWindow).__argusGlobe!.getCamera(),
  );

  const first = page
    .getByRole("region", { name: "Brief" })
    .getByRole("listitem")
    .first()
    .getByRole("button");
  await expect(first).toBeVisible();
  await first.click();

  await expect(page.getByRole("heading", { name: "Citations" })).toBeVisible();
  const record = page.locator("article").first();
  await expect(record).toBeVisible();
  await expect(record.getByText("Stored record")).toBeVisible();

  // The flight lasts 1.5 s; the camera ends far lower than the whole-Earth start.
  await expect
    .poll(
      async () =>
        page.evaluate(() => (window as InstrumentedWindow).__argusGlobe!.getCamera().heightMeters),
      { timeout: 10_000 },
    )
    .toBeLessThan(before.heightMeters / 3);

  expect(problems).toEqual([]);
});

for (const width of [390, 360]) {
  test(`phone ${width}px: no sideways scroll, the full honesty strip, and the citation opens`, async ({
    page,
  }) => {
    const problems: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") problems.push(m.text());
    });
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");

    const strip = page.locator("[data-honesty-strip]");
    await expect(strip).toBeVisible();
    // Every part of the strip shows in full: nothing clipped by an ellipsis.
    const clipped = await strip
      .locator("span:not(.sr-only), a")
      .evaluateAll(
        (els) => els.filter((e) => e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1).length,
      );
    expect(clipped).toBe(0);

    const first = page
      .getByRole("region", { name: "Brief" })
      .getByRole("listitem")
      .first()
      .getByRole("button");
    await expect(first).toBeVisible();
    const fits = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
      );
    expect(await fits()).toBe(true);

    await first.click();
    await expect(page.getByRole("heading", { name: "Citations" })).toBeVisible();
    await expect(page.locator("article").first().getByText("Stored record")).toBeVisible();
    expect(await fits()).toBe(true);
    expect(problems).toEqual([]);
  });
}

test("the rail states each recorded layer's own span, read from the snapshot", async ({ page }) => {
  const replay = JSON.parse(
    readFileSync(join(import.meta.dirname, "../../public/snapshot/replay.json"), "utf8"),
  ) as ReplaySummary;
  const spans = layerSpans(replay);
  await page.goto("/");

  const crumb = crumbLabel({ from: replay.from, to: replay.to });
  await expect(page.getByText(crumb, { exact: true }).first()).toBeVisible();
  const rail = page.getByRole("complementary", { name: "Console" });
  await expect(rail.getByText(`Recorded ${spanLabel(spans.flights!)} only.`)).toBeVisible();
  await expect(rail.locator('[title^="Recorded "]')).toHaveCount(4);
});
