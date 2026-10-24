import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  outputDir: "test-results",
  use: {
    baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3000",
    ...devices["Desktop Chrome"],
    screenshot: "only-on-failure",
    trace: "off",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  webServer: {
    command: "node .next/standalone/server.js",
    url: process.env.BASE_URL ?? "http://127.0.0.1:3000/login",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
