import { defineConfig, devices } from "@playwright/test";

// The workers read the daemon's SQLite file (`piFile`): node:sqlite prints an experimental warning in every worker.
process.env["NODE_OPTIONS"] = [process.env["NODE_OPTIONS"], "--disable-warning=ExperimentalWarning"]
  .filter(Boolean)
  .join(" ");

// PAP_E2E_WS is set by run.ts when the browsers live in the pinned container (M13R2); unset, they are local.
const connectOptions = process.env["PAP_E2E_WS"] ? { wsEndpoint: process.env["PAP_E2E_WS"] } : undefined;
const desktop = /\.e2e\.ts$/;
const phone = /j06-.*\.e2e\.ts$/;

export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 2,
  retries: 0, // a retry hides a flake
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  outputDir: "test-results",
  use: { trace: "retain-on-failure" },
  projects: [
    // M13R40: the desktop projects skip the phone journeys, the phone projects run nothing else.
    {
      name: "chromium",
      testMatch: desktop,
      testIgnore: /j06-/,
      use: { ...devices["Desktop Chrome"], connectOptions },
    },
    {
      name: "webkit",
      testMatch: desktop,
      testIgnore: /j06-/,
      use: { ...devices["Desktop Safari"], connectOptions },
    },
    { name: "chromium-phone", testMatch: phone, use: { ...devices["Pixel 7"], connectOptions } },
    { name: "webkit-phone", testMatch: phone, use: { ...devices["iPhone 13"], connectOptions } },
  ],
});
