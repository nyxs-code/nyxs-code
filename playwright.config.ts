import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.NYXS_E2E_PORT ?? 1431);

// E2E tests: the real frontend in a browser, with the Tauri backend and the model faked
// (e2e/bootstrap.ts, e2e/fixtures.ts). Locally they use the installed Edge, so no browser
// download is needed; CI installs Playwright's Chromium.
export default defineConfig({
  testDir: "e2e/tests",
  // One page load before the first test, so no test pays for Vite's cold start (e2e/warmup.ts).
  globalSetup: "./e2e/warmup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // The dev CSP only lets the page talk to IPC; here model requests go through the page's
    // own fetch so Playwright can answer them.
    bypassCSP: true,
    locale: "es-ES",
  },
  projects: [
    {
      name: "chromium",
      // This device's user agent says Windows on every OS, and the app picks its path style
      // from the user agent (src/tools/env.ts), so the fake project at C:/e2e/project works
      // the same on a Linux runner.
      use: { ...devices["Desktop Chrome"], channel: process.env.CI ? undefined : "msedge" },
    },
  ],
  webServer: {
    command: `node node_modules/vite/bin/vite.js -c e2e/vite.config.ts`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
