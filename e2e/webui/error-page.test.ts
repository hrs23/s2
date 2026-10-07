import { expect, test } from "@playwright/test";

test("unknown route shows English 404 page with back-home link", async ({
  page,
}) => {
  const response = await page.goto("/no-such-route");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Page not found",
  );
  const home = page.getByRole("link", { name: "Back to home" });
  await expect(home).toBeVisible();
  await expect(home).toHaveAttribute("href", "/");
});

test("unknown /ja route shows English 404 page under EN-only public web", async ({
  page,
}) => {
  const response = await page.goto("/ja/no-such-route");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Page not found",
  );
  const home = page.getByRole("link", { name: "Back to home" });
  await expect(home).toBeVisible();
  await expect(home).toHaveAttribute("href", "/");
});
