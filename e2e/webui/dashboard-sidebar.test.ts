import { expect, test } from "@playwright/test";
import { setAuthCookie } from "../helpers";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:8888";

// Warm up the Vite dev server before the first test. The first browser
// navigation after a cold start can trigger a React hydration error because
// the framework context isn't fully initialised by Vite yet (same workaround
// as e2e/visual/dashboard.test.ts).
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await setAuthCookie(page);
  await page.goto("/files");
  await page.waitForLoadState("networkidle");
  await context.close();
});

test.beforeEach(async ({ page }) => {
  await setAuthCookie(page);
  // Dismiss the beta banner so it doesn't push layout down by ~25px and
  // confuse the sidebar position assertions below.
  await page.context().addCookies([
    {
      name: "s2_beta_dismissed",
      value: "1",
      domain: new URL(baseURL).hostname,
      path: "/",
    },
  ]);
});

test("desktop sidebar is sticky and fills the viewport height", async ({
  page,
}) => {
  await page.goto("/files");
  const sidebar = page.locator("aside.sticky").first();
  await expect(sidebar).toBeVisible();

  const viewport = page.viewportSize();
  if (!viewport) throw new Error("viewport size unavailable");

  const styles = await sidebar.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { position: cs.position, top: cs.top };
  });
  expect(styles.position).toBe("sticky");
  expect(styles.top).toBe("0px");

  const box = await sidebar.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.y).toBeCloseTo(0, 0);
  expect(box?.height).toBeCloseTo(viewport.height, 0);
});

test("sidebar scrolls internally when its content exceeds the viewport", async ({
  page,
}) => {
  // Force a very short viewport so the sidebar's own content (nav links +
  // storage + email + logout) overflows vertically. This exercises
  // overflow-y-auto, not just the sticky behavior.
  await page.setViewportSize({ width: 1280, height: 240 });
  await page.goto("/files");

  const sidebar = page.locator("aside.sticky").first();
  await expect(sidebar).toBeVisible();

  const { scrollHeight, clientHeight } = await sidebar.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(scrollHeight).toBeGreaterThan(clientHeight);
});

test("mobile drawer opens and closes", async ({ page }) => {
  await setAuthCookie(page);
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/files");
  await page.waitForLoadState("networkidle");
  await page.locator("main").first().waitFor();

  // Open drawer — slides in (translate-x-0)
  await page.click('[aria-label="Open menu"]');
  await expect(page.locator('[role="dialog"]')).toHaveClass(/translate-x-0/);

  // Close drawer — slides out (-translate-x-full)
  await page.click('[aria-label="Close menu"]');
  await expect(page.locator('[role="dialog"]')).toHaveClass(/-translate-x-full/);
});
