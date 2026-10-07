import { expect, test } from "@playwright/test";
import { deleteFile, setAuthCookie, uploadFile } from "../helpers";

test.beforeEach(async ({ page }) => {
  await setAuthCookie(page);
});

test("creating a text file shows it in the list", async ({ page }) => {
  const filename = `e2e-create-${Date.now()}.txt`;
  await page.goto("/files");

  await page.click("button:has-text('+ Text')");
  await page.fill('input[placeholder*="e.g."]', filename);
  await page.fill("textarea", "E2E test content");
  await page.click('button[type="submit"]:has-text("Save")');

  await expect(page.getByRole("button", { name: filename }).first()).toBeVisible();

  // Cleanup
  await deleteFile(page, filename);
});

test("clicking a file opens the viewer", async ({ page }) => {
  // .md files render as sanitized HTML (see file-preview.tsx MarkdownView),
  // so assert via heading role rather than a <pre> locator.
  const filename = `e2e-view-${Date.now()}.md`;
  await uploadFile(page, filename, "# Hello E2E\nThis is a test.");
  await page.goto("/files");

  await page.getByRole("button", { name: filename }).first().click();
  await expect(
    page.getByRole("heading", { name: "Hello E2E" }),
  ).toBeVisible();
  await page.click("button:has-text('Close')");

  await deleteFile(page, filename);
});

test("creating a folder shows the folder", async ({ page }) => {
  const folderName = `e2e-folder-${Date.now()}`;
  await page.goto("/files");

  await page.click("button:has-text('+ Folder')");
  await page.locator('input[placeholder*="e.g."]').fill(folderName);
  await page.click('button[type="submit"]:has-text("Create")');

  await expect(
    page.getByRole("button", { name: `${folderName}/` }).first(),
  ).toBeVisible({ timeout: 10_000 });

  // Cleanup
  await deleteFile(page, `${folderName}/`);
});
