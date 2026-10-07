import { expect, test } from "@playwright/test";
import { deleteFile, setAuthCookie, uploadFile } from "../helpers";

test.beforeEach(async ({ page }) => {
  await setAuthCookie(page);
});

test("Deleted file appears in trash", async ({ page }) => {
  const filename = `e2e-trash-${Date.now()}.txt`;
  await uploadFile(page, filename, "trash me");
  await deleteFile(page, filename);

  await page.goto("/files?tab=trash");
  const row = page.getByRole("row").filter({ hasText: filename });
  await expect(row).toBeVisible();
  await expect(row.getByText(/\d+ days? left/)).toBeVisible();
  await row.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText(filename)).not.toBeVisible({ timeout: 10_000 });
  await deleteFile(page, filename);
});

test("Permanently delete removes file from trash", async ({ page }) => {
  const filename = `e2e-purge-${Date.now()}.txt`;
  await uploadFile(page, filename, "purge me");
  await deleteFile(page, filename);

  await page.goto("/files?tab=trash");
  const row = page.getByRole("row").filter({ hasText: filename });
  await expect(row).toBeVisible();

  // Click permanently delete and confirm
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: /delete permanently/i }).click();

  // File should disappear from trash immediately
  await expect(page.getByText(filename)).not.toBeVisible({ timeout: 10_000 });
});

test("Purge all removes all files from trash", async ({ page }) => {
  const file1 = `e2e-purgeall-a-${Date.now()}.txt`;
  const file2 = `e2e-purgeall-b-${Date.now()}.txt`;
  await uploadFile(page, file1, "purge all a");
  await uploadFile(page, file2, "purge all b");
  await deleteFile(page, file1);
  await deleteFile(page, file2);

  await page.goto("/files?tab=trash");
  await expect(page.getByText(file1)).toBeVisible();
  await expect(page.getByText(file2)).toBeVisible();

  // Click empty trash and confirm
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /empty trash/i }).click();

  // Both files should disappear
  await expect(page.getByText(file1)).not.toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(file2)).not.toBeVisible({ timeout: 10_000 });
});
