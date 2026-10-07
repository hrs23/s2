import { defineConfig } from "@playwright/test";
import { ensureDevVars } from "./ensure-dev-vars";

ensureDevVars();

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:8888";
const isContainer = !!process.env.E2E_CONTAINER;

export default defineConfig({
  testDir: "./api",
  outputDir: "./test-results",
  reporter: [["html", { outputFolder: "./playwright-report" }]],
  globalSetup: "./global-setup.ts",
  timeout: 30_000,
  retries: 1,
  workers: isContainer ? 1 : undefined,
  use: {
    baseURL,
    extraHTTPHeaders: {
      Accept: "application/json",
      // `/internal/*` (and cookie-auth on `/api/v1/*`) mutations
      // require a same-origin Origin header.
      Origin: baseURL,
    },
  },
  webServer: isContainer
    ? undefined
    : {
        command: "pnpm dev",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
  // API tests don't need a browser
  projects: [{ name: "api" }],
});
