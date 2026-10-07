import { defineConfig } from "@playwright/test";
import { ensureDevVars } from "./ensure-dev-vars";

ensureDevVars();

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:8888";
const isContainer = !!process.env.E2E_CONTAINER;

export default defineConfig({
  testDir: "./visual",
  outputDir: "./test-results",
  reporter: [["html", { outputFolder: "./playwright-report" }]],
  globalSetup: "./global-setup.ts",
  timeout: 30_000,
  retries: 0,
  workers: isContainer ? 1 : undefined,
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
      animations: "disabled",
    },
  },
  use: {
    baseURL,
  },
  webServer: isContainer
    ? undefined
    : {
        command: "pnpm dev",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
