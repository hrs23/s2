import { expect, test, type Page } from "@playwright/test";
import { deleteToken, issueToken, setAuthCookie } from "../helpers";

async function gotoApp(page: Page, path: string) {
  await page.goto(path);
}

async function recoverAppError(page: Page) {
  const appError = page.getByRole("heading", { name: "Application Error" });
  if (await appError.isVisible().catch(() => false)) {
    await page.reload();
  }
}

test.beforeEach(async ({ page }) => {
  await gotoApp(page, "/login");
  await recoverAppError(page);
  await setAuthCookie(page);
});

test("Can create a new API token", async ({ page }) => {
  const tokenName = `e2e-token-${Date.now()}`;
  await gotoApp(page, "/tokens");

  await page.click("button:has-text('New Token')");
  await page.getByRole("textbox", { name: /e\.g\./ }).fill(tokenName);
  await page.click('button[type="submit"]:has-text("Create")');

  // Token is displayed as a card with the name
  await expect(page.getByRole("button", { name: tokenName }).first()).toBeVisible();

  // Cleanup: delete the created token (session cookie is already set)
  const tokensRes = await page.request.get("/internal/tokens");
  const { tokens: list } = await tokensRes.json();
  const created = list.find(
    (t: { name: string; id: string }) => t.name === tokenName,
  );
  if (created) {
    await page.request.delete(`/api/v1/tokens/${created.id}`);
  }
});

test("Created token shows Rotate button (auto-issued)", async ({ page }) => {
  // POST /api/v1/tokens auto-issues, so a newly created row already has an
  // active secret and the card surfaces the "Rotate" action (not "Issue").
  const tokenName = `e2e-tok-rot-${Date.now()}`;
  const createdToken = await issueToken(page, {
    name: tokenName,
    access_paths: [{ path: "", access: "write" }],
  });

  await gotoApp(page, "/tokens");
  await expect(page.locator("text=Loading...")).not.toBeVisible({
    timeout: 10_000,
  });
  const card = page.locator(".grid > div.rounded-lg").filter({
    has: page.getByRole("button", { name: tokenName }),
  });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Rotate", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Rotate token" })).toBeVisible();

  // Cleanup
  await deleteToken(page, createdToken.id);
});
