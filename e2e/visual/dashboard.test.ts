import { expect, test } from "@playwright/test";
import { setAuthCookie } from "../helpers";

// Warm up the Vite dev server before snapshot tests. The first browser
// navigation after a cold start can trigger a React hydration error because
// the framework context isn't fully initialised by Vite yet. A dummy
// navigation (no screenshot) ensures all modules are compiled and the
// router context is ready for the real tests.
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await setAuthCookie(page);
  await page.goto("/files");
  await page.waitForLoadState("networkidle");
  await context.close();
});

const viewports = {
  mobile: { width: 375, height: 667 },
  desktop: { width: 1280, height: 800 },
} as const;

const dashboardPages = [
  { name: "files", path: "/files", waitFor: "main" },
  { name: "tokens", path: "/tokens", waitFor: "main" },
  { name: "settings", path: "/settings", waitFor: "main" },
] as const;

for (const { name, path: pagePath, waitFor } of dashboardPages) {
  for (const [viewport, size] of Object.entries(viewports)) {
    test(`${name} - ${viewport}`, async ({ page }) => {
      await setAuthCookie(page);
      await page.setViewportSize(size);
      await page.goto(pagePath);
      await page.locator(waitFor).first().waitFor();
      await page.waitForLoadState("networkidle");
      await expect(page).toHaveScreenshot(`dashboard-${name}-${viewport}.png`);
    });
  }
}
