import { defineConfig } from "@playwright/test";
import { ensureDevVars } from "./ensure-dev-vars";

// Generate .dev.vars before webServer starts (must run at import time)
ensureDevVars();

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:8888";
// E2E_CONTAINER=true: app is managed by Docker Compose, not Playwright
const isContainer = !!process.env.E2E_CONTAINER;

export default defineConfig({
  testDir: "./webui",
  outputDir: "./test-results",
  reporter: [["html", { outputFolder: "./playwright-report" }]],
  globalSetup: "./global-setup.ts",
  timeout: 30_000,
  retries: 1,
  // the dev server is unstable under high concurrency in containers
  workers: isContainer ? 1 : undefined,
  use: {
    baseURL,
    // `/internal/*` (and cookie-auth on `/api/v1/*`) mutations
    // require a same-origin `Origin` header. Playwright's page.request
    // fixture is server-side and does not attach one by default, so we set
    // it explicitly to baseURL.
    extraHTTPHeaders: { Origin: baseURL },
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
