import { expect, test } from "@playwright/test";
import { setAuthCookie } from "../helpers";

test("redirects unauthenticated /files access to /login", async ({
  page,
}) => {
  await page.goto("/files");
  await expect(page).toHaveURL(/\/login/);
});

test("/login shows the email/password sign-in form", async ({
  page,
}) => {
  await page.goto("/login");
  await expect(
    page.locator('input[type="email"][autocomplete="email"]'),
  ).toBeVisible();
  await expect(
    page.locator('input[type="password"][autocomplete="current-password"]'),
  ).toBeVisible();
});

test("/login shows a link to /signup", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator('a[href="/signup"]').first()).toBeVisible();
});

test("/signup has no name field and links to /login", async ({
  page,
}) => {
  await page.goto("/signup");
  // Name field removed — sign-up only collects email + password.
  await expect(page.locator('input[name="name"]')).toHaveCount(0);
  await expect(
    page.locator('input[type="email"][autocomplete="email"]'),
  ).toBeVisible();
  await expect(page.locator('a[href="/login"]').first()).toBeVisible();
});

test("redirects / to the dashboard when a Better Auth session is set", async ({
  page,
}) => {
  await setAuthCookie(page);
  await page.goto("/");
  // / redirects to /files
  await expect(page).toHaveURL(/\/files/);
  await expect(
    page.getByRole("link", { name: "My Files" }).first(),
  ).toBeVisible();
});

test("shows the sidebar navigation links", async ({ page }) => {
  await setAuthCookie(page);
  await page.goto("/files");
  await expect(
    page.getByRole("link", { name: "My Files" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "API Tokens" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Settings" }).first(),
  ).toBeVisible();
});

test("/settings shows the change-password form (credential user)", async ({
  page,
}) => {
  // /settings is a client-loader route — wait for the form to render after
  // the loader resolves, which on a cold dev server can take a few seconds.
  await setAuthCookie(page);
  await page.goto("/settings");
  await expect(
    page.locator('input[autocomplete="current-password"]'),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator('input[autocomplete="new-password"]'),
  ).toBeVisible();
});
