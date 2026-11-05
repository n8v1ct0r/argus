import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.ARGUS_TEST_PORT ?? 3100);

export default defineConfig({
  timeout: 90_000,
  reporter: [["list"]],
  projects: [
    {
      // Pure logic tests: detectors, checker, normalizers, redaction. No browser, no server.
      name: "unit",
      testDir: "tests/unit",
    },
    {
      name: "e2e",
      testDir: "tests/e2e",
      use: {
        ...devices["Desktop Chrome"],
        // New headless (real Chrome) uses the GPU on macOS; the default headless shell falls
        // back to SwiftShader, which would understate the frame rate.
        channel: "chromium",
        viewport: { width: 1440, height: 900 },
        baseURL: `http://localhost:${PORT}`,
      },
    },
  ],
  // Only the e2e project needs the app server; unit tests stay browser- and server-free.
  webServer: process.env.PW_E2E
    ? {
        command: `pnpm start --port ${PORT}`,
        url: `http://localhost:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: { MODEL_MODE: "replay" },
      }
    : undefined,
});
