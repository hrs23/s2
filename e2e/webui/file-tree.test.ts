/**
 * E2E tests for file tree operations.
 * Covers: folder navigation, nested folders, breadcrumbs, file editing,
 * upload/download, version restore with content verification,
 * trash round-trip, empty folders, folder delete, sorting.
 */
import { expect, test } from "@playwright/test";
import {
  createFolder,
  deleteFile,
  setAuthCookie,
  uploadFile,
} from "../helpers";

test.beforeEach(async ({ page }) => {
  await setAuthCookie(page);
});

// ---------------------------------------------------------------------------
// Folder navigation & breadcrumbs
// ---------------------------------------------------------------------------

test("entering a folder and returning via the breadcrumb root link", async ({
  page,
}) => {
  const folder = `e2e-bc-${Date.now()}`;
  await uploadFile(page, `${folder}/child.txt`, "breadcrumb test");
  await page.goto("/files");

  // Navigate into folder
  await page.getByRole("button", { name: `${folder}/` }).first().click();
  await expect(page).toHaveURL(/prefix=/);
  await expect(
    page.getByRole("button", { name: "child.txt" }).first(),
  ).toBeVisible();

  // Click root breadcrumb button to go back
  const nav = page.locator("nav");
  await nav.getByRole("button").first().click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(
    page.getByRole("button", { name: `${folder}/` }).first(),
  ).toBeVisible();

  await deleteFile(page, `${folder}/child.txt`);
  await deleteFile(page, `${folder}/`);
});

test("navigating nested folders (a/b/c)", async ({ page }) => {
  const root = `e2e-nest-${Date.now()}`;
  await uploadFile(page, `${root}/mid/deep/file.txt`, "deep file");
  await page.goto("/files");

  // root → mid → deep
  await page.getByRole("button", { name: `${root}/` }).first().click();
  await expect(
    page.getByRole("button", { name: "mid/" }).first(),
  ).toBeVisible();

  await page.getByRole("button", { name: "mid/" }).first().click();
  await expect(
    page.getByRole("button", { name: "deep/" }).first(),
  ).toBeVisible();

  await page.getByRole("button", { name: "deep/" }).first().click();
  await expect(
    page.getByRole("button", { name: "file.txt" }).first(),
  ).toBeVisible();

  // Breadcrumb shows all segments — click "mid" button to jump back
  const midBreadcrumb = page.locator("nav").getByRole("button", { name: "mid" });
  await expect(midBreadcrumb).toBeVisible();
  await midBreadcrumb.click();
  await expect(
    page.getByRole("button", { name: "deep/" }).first(),
  ).toBeVisible();

  // Cleanup
  await deleteFile(page, `${root}/mid/deep/file.txt`);
  await deleteFile(page, `${root}/mid/deep/`);
  await deleteFile(page, `${root}/mid/`);
  await deleteFile(page, `${root}/`);
});

// ---------------------------------------------------------------------------
// File creation inside folders
// ---------------------------------------------------------------------------

test("creating a text file inside a folder", async ({ page }) => {
  const folder = `e2e-fcreate-${Date.now()}`;
  await createFolder(page, folder);
  await page.goto(`/files?prefix=${encodeURIComponent(`${folder}/`)}`);

  // Create file via UI
  const filename = "new-file.txt";
  await page.click("button:has-text('+ Text')");
  await page.fill('input[placeholder*="e.g."]', filename);
  await page.fill("textarea", "created inside folder");
  await page.click('button[type="submit"]:has-text("Save")');

  await expect(
    page.getByRole("button", { name: filename }).first(),
  ).toBeVisible({ timeout: 10_000 });

  // Cleanup
  await deleteFile(page, `${folder}/${filename}`);
  await deleteFile(page, `${folder}/`);
});

test("creating a subfolder inside a folder", async ({ page }) => {
  const folder = `e2e-subfolder-${Date.now()}`;
  await createFolder(page, folder);
  await page.goto(`/files?prefix=${encodeURIComponent(`${folder}/`)}`);

  const subName = "sub";
  await page.click("button:has-text('+ Folder')");
  await page.locator('input[placeholder*="e.g."]').fill(subName);
  await page.click('button[type="submit"]:has-text("Create")');

  await expect(
    page.getByRole("button", { name: `${subName}/` }).first(),
  ).toBeVisible({ timeout: 10_000 });

  // Cleanup
  await deleteFile(page, `${folder}/${subName}/`);
  await deleteFile(page, `${folder}/`);
});

// ---------------------------------------------------------------------------
// File editing
// ---------------------------------------------------------------------------

test("editing and saving a file updates its content", async ({ page }) => {
  const filename = `e2e-edit-${Date.now()}.txt`;
  await uploadFile(page, filename, "before edit");
  await page.goto("/files");

  // Open viewer
  await page.getByRole("button", { name: filename }).first().click();
  await expect(page.locator("pre")).toContainText("before edit");

  // Click edit button (exact match to avoid matching filename)
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const textarea = page.locator("textarea");
  await expect(textarea).toBeVisible();
  await textarea.fill("after edit");
  await page.getByRole("button", { name: "Save" }).click();

  // Wait for save to complete (button changes back)
  await expect(page.getByRole("button", { name: "Edit" })).toBeVisible({
    timeout: 10_000,
  });

  // Close and reopen to verify
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: filename }).first().click();
  await expect(page.locator("pre")).toContainText("after edit");

  await page.getByRole("button", { name: "Close" }).click();
  await deleteFile(page, filename);
});

// ---------------------------------------------------------------------------
// File upload via UI button
// ---------------------------------------------------------------------------

test("uploading a file via the upload dialog", async ({ page }) => {
  const filename = `e2e-upload-${Date.now()}.txt`;
  await page.goto("/files");

  // Open upload dialog
  await page.click("button:has-text('Upload')");

  // Set file in the file input inside the dialog
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: filename,
    mimeType: "text/plain",
    buffer: Buffer.from("uploaded via dialog"),
  });

  // Submit the upload form
  await page.click('button[type="submit"]:has-text("Upload")');

  // Wait for upload to complete and file to appear
  await expect(
    page.getByRole("button", { name: filename }).first(),
  ).toBeVisible({ timeout: 15_000 });

  await deleteFile(page, filename);
});

test("uploading multiple files at once", async ({ page }) => {
  const stamp = Date.now();
  const file1 = `e2e-multi-${stamp}-a.txt`;
  const file2 = `e2e-multi-${stamp}-b.txt`;
  await page.goto("/files");

  await page.click("button:has-text('Upload')");

  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles([
    { name: file1, mimeType: "text/plain", buffer: Buffer.from("alpha") },
    { name: file2, mimeType: "text/plain", buffer: Buffer.from("beta") },
  ]);

  await page.click('button[type="submit"]:has-text("Upload")');

  await expect(
    page.getByRole("button", { name: file1 }).first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("button", { name: file2 }).first(),
  ).toBeVisible({ timeout: 15_000 });

  await deleteFile(page, file1);
  await deleteFile(page, file2);
});

// ---------------------------------------------------------------------------
// File download
// ---------------------------------------------------------------------------

test("downloading a file", async ({ page }) => {
  const filename = `e2e-dl-${Date.now()}.txt`;
  await uploadFile(page, filename, "download test content");
  await page.goto("/files");

  // Open viewer
  await page.getByRole("button", { name: filename }).first().click();

  // Wait for viewer content to load, then find the download link
  await expect(page.locator("pre")).toContainText("download test content");
  // The download link in the viewer dialog (z-50 modal)
  const dialog = page.locator(".fixed.inset-0.z-50 > .relative.z-50");
  const downloadLink = dialog.locator("a[download]");
  await expect(downloadLink).toBeVisible({ timeout: 5_000 });

  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe(filename);

  await page.getByRole("button", { name: "Close" }).click();
  await deleteFile(page, filename);
});

// ---------------------------------------------------------------------------
// Version restore with content verification
// ---------------------------------------------------------------------------

test("restoring a version reverts the file content", async ({ page }) => {
  const filename = `e2e-vrestore-${Date.now()}.txt`;
  await uploadFile(page, filename, "v1 original");
  await uploadFile(page, filename, "v2 updated");
  await page.goto("/files");

  // Open and confirm v2
  await page.getByRole("button", { name: filename }).first().click();
  await expect(page.locator("pre")).toContainText("v2 updated");

  // Restore v1
  await page.getByRole("button", { name: "Version history" }).click();
  await expect(page.getByText("Current")).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: "Restore", exact: true }).click();

  // Close and reopen — should show v1
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: filename }).first().click();
  await expect(page.locator("pre")).toContainText("v1 original");

  await page.getByRole("button", { name: "Close" }).click();
  await deleteFile(page, filename);
});

// ---------------------------------------------------------------------------
// Trash round-trip: delete → trash → restore → back in original folder
// ---------------------------------------------------------------------------

test("deleting a file in a folder, then restoring it from trash returns it to the folder", async ({
  page,
}) => {
  const folder = `e2e-trash-rt-${Date.now()}`;
  const filename = "important.txt";
  await uploadFile(page, `${folder}/${filename}`, "don't lose me");

  // Navigate to folder and delete the file via UI
  await page.goto(`/files?prefix=${encodeURIComponent(`${folder}/`)}`);
  await expect(
    page.getByRole("button", { name: filename }).first(),
  ).toBeVisible();

  const row = page
    .getByRole("button", { name: filename })
    .first()
    .locator("../..");
  await row.hover();
  await row.locator('button[title="Delete"]').click({ force: true });
  await row.locator("button.bg-red-500").click();

  // File should disappear
  await expect(
    page.getByRole("button", { name: filename }),
  ).not.toBeVisible({ timeout: 10_000 });

  // Go to trash and restore
  await page.goto("/files?tab=trash");
  const trashRow = page.getByRole("row").filter({ hasText: filename });
  await expect(trashRow).toBeVisible();
  await trashRow.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText(filename)).not.toBeVisible({ timeout: 10_000 });

  // Verify file is back in original folder
  await page.goto(`/files?prefix=${encodeURIComponent(`${folder}/`)}`);
  await expect(
    page.getByRole("button", { name: filename }).first(),
  ).toBeVisible();

  // Cleanup
  await deleteFile(page, `${folder}/${filename}`);
  await deleteFile(page, `${folder}/`);
});

// ---------------------------------------------------------------------------
// Empty folder
// ---------------------------------------------------------------------------

test("opening an empty folder shows the empty state", async ({ page }) => {
  const folder = `e2e-empty-${Date.now()}`;
  await page.goto("/files");

  await page.click("button:has-text('+ Folder')");
  await page.locator('input[placeholder*="e.g."]').fill(folder);
  await page.click('button[type="submit"]:has-text("Create")');
  await expect(
    page.getByRole("button", { name: `${folder}/` }).first(),
  ).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: `${folder}/` }).first().click();
  await expect(page).toHaveURL(/prefix=/);

  // Should show empty state text
  await expect(page.getByText("No files")).toBeVisible({ timeout: 5_000 });
  // Action buttons should still work from empty folder
  await expect(page.locator("button:has-text('+ Text')")).toBeVisible();
  await expect(page.locator("button:has-text('Upload')")).toBeVisible();

  await deleteFile(page, `${folder}/`);
});

// ---------------------------------------------------------------------------
// Folder delete via UI
// ---------------------------------------------------------------------------

test("deleting a folder via the UI also deletes its child files", async ({
  page,
}) => {
  const folder = `e2e-foldel-${Date.now()}`;
  await uploadFile(page, `${folder}/a.txt`, "file a");
  await uploadFile(page, `${folder}/b.txt`, "file b");
  await page.goto("/files");

  // Folder should be visible
  await expect(
    page.getByRole("button", { name: `${folder}/` }).first(),
  ).toBeVisible({ timeout: 10_000 });

  // Hover folder row and click delete
  const row = page
    .getByRole("button", { name: `${folder}/` })
    .first()
    .locator("../..");
  await row.hover();
  await row.locator('button[title="Delete"]').click({ force: true });

  // Confirm delete (red button)
  await row.locator("button.bg-red-500").click();

  // Folder should disappear
  await expect(
    page.getByRole("button", { name: `${folder}/` }),
  ).not.toBeVisible({ timeout: 10_000 });

  // Children should also be gone (verify via API)
  const res = await page.request.get(`/api/v1/files/${folder}/a.txt`);
  expect(res.status()).toBe(404);
});

// ---------------------------------------------------------------------------
// Sorting — folders always first, files sorted by column
// ---------------------------------------------------------------------------

test("sorting: folders always appear above files", async ({ page }) => {
  const prefix = `e2e-sort-${Date.now()}`;
  await uploadFile(page, `${prefix}/z-file.txt`, "z");
  await uploadFile(page, `${prefix}/a-file.txt`, "a");
  await createFolder(page, `${prefix}/subfolder`);

  await page.goto(`/files?prefix=${encodeURIComponent(`${prefix}/`)}`);

  await expect(
    page.getByRole("button", { name: "subfolder/" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "a-file.txt" }).first(),
  ).toBeVisible();

  // Get all item names in order — desktop uses flex rows in the list
  const names = page.locator("button.font-mono");
  const allNames = await names.allTextContents();
  const folderIdx = allNames.findIndex((n) => n.includes("subfolder"));
  const fileIdx = allNames.findIndex((n) => n.includes("a-file"));
  // Folder should appear before files regardless of sort
  expect(folderIdx).toBeLessThan(fileIdx);

  // Click Name sort to toggle order — folder should still be first
  const sortButtons = page.locator(".bg-gray-50 button").filter({ hasText: "Name" });
  if (await sortButtons.first().isVisible().catch(() => false)) {
    await sortButtons.first().click();
    await page.waitForTimeout(500);
    const namesAfter = await names.allTextContents();
    const folderIdxAfter = namesAfter.findIndex((n) => n.includes("subfolder"));
    const fileIdxAfter = namesAfter.findIndex((n) => n.includes("a-file"));
    expect(folderIdxAfter).toBeLessThan(fileIdxAfter);
  }

  await deleteFile(page, `${prefix}/z-file.txt`);
  await deleteFile(page, `${prefix}/a-file.txt`);
  await deleteFile(page, `${prefix}/subfolder/`);
  await deleteFile(page, `${prefix}/`);
});

// ---------------------------------------------------------------------------
// Delete cancel
// ---------------------------------------------------------------------------

test("cancelling delete confirmation keeps the file", async ({ page }) => {
  const filename = `e2e-delcancel-${Date.now()}.txt`;
  await uploadFile(page, filename, "keep me");
  await page.goto("/files");

  const row = page
    .getByRole("button", { name: filename })
    .first()
    .locator("../..");
  await row.hover();
  await row.locator('button[title="Delete"]').click({ force: true });

  // Cancel the delete (Cancel text button next to red Delete)
  await row.getByRole("button", { name: "Cancel", exact: true }).click();

  // File should still be visible
  await expect(
    page.getByRole("button", { name: filename }).first(),
  ).toBeVisible();

  await deleteFile(page, filename);
});

// ---------------------------------------------------------------------------
// Rename via UI
// ---------------------------------------------------------------------------

test("renaming a file via the UI", async ({ page }) => {
  const original = `e2e-ren-${Date.now()}.txt`;
  const renamed = `e2e-ren-${Date.now()}-new.txt`;
  await uploadFile(page, original, "rename me");
  await page.goto("/files");

  // Original visible, renamed absent
  await expect(
    page.getByRole("button", { name: original }).first(),
  ).toBeVisible({ timeout: 10_000 });

  // Hover row and click the rename (pencil) action — matches the
  // delete-confirm pattern already exercised elsewhere in this suite.
  const row = page
    .getByRole("button", { name: original })
    .first()
    .locator("../..");
  await row.hover();
  await row.locator('button[title="Rename"]').click({ force: true });

  // Dialog opens pre-filled with the current name. Fill the new one and
  // submit via the "Rename" button (the dialog's own action, not the
  // row's pencil icon — dialog button has type=submit and a text label).
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Rename file")).toBeVisible();
  const input = dialog.locator("input").first();
  await expect(input).toHaveValue(original);
  await input.fill(renamed);
  await dialog.getByRole("button", { name: "Rename", exact: true }).click();

  // Old row gone, new row visible.
  await expect(
    page.getByRole("button", { name: original }),
  ).not.toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByRole("button", { name: renamed }).first(),
  ).toBeVisible();

  // API cross-check: the new path serves the old content, the old path
  // is gone. Guards against a "UI changed but server didn't" regression.
  const resOld = await page.request.get(`/api/v1/files/${original}`);
  expect(resOld.status()).toBe(404);
  const resNew = await page.request.get(`/api/v1/files/${renamed}`);
  expect(resNew.status()).toBe(200);
  expect(await resNew.text()).toBe("rename me");

  await deleteFile(page, renamed);
});

test("renaming a folder via the UI makes its files reachable at the new path", async ({
  page,
}) => {
  const folder = `e2e-foldren-${Date.now()}`;
  const renamed = `${folder}-new`;
  await uploadFile(page, `${folder}/inside.txt`, "folder rename");
  await page.goto("/files");

  await expect(
    page.getByRole("button", { name: `${folder}/` }).first(),
  ).toBeVisible({ timeout: 10_000 });

  const row = page
    .getByRole("button", { name: `${folder}/` })
    .first()
    .locator("../..");
  await row.hover();
  await row.locator('button[title="Rename"]').click({ force: true });

  const dialog = page.getByRole("dialog");
  // Folder dialog title differs from file dialog title — verify that the
  // UI picks the right variant based on entry.type.
  await expect(dialog.getByText("Rename folder")).toBeVisible();
  const input = dialog.locator("input").first();
  await expect(input).toHaveValue(folder);
  await input.fill(renamed);
  await dialog.getByRole("button", { name: "Rename", exact: true }).click();

  // New folder row visible, old one gone.
  await expect(
    page.getByRole("button", { name: `${renamed}/` }).first(),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByRole("button", { name: `${folder}/` }),
  ).not.toBeVisible();

  // Child file must be reachable via the new parent path — rename of a
  // directory is a "move-dir" operation and must cascade the
  // absolute path of every descendant. API check rather than UI
  // navigation to keep the assertion focused.
  const resChild = await page.request.get(`/api/v1/files/${renamed}/inside.txt`);
  expect(resChild.status()).toBe(200);
  expect(await resChild.text()).toBe("folder rename");

  await deleteFile(page, `${renamed}/inside.txt`);
  await deleteFile(page, `${renamed}/`);
});

test("renaming onto an existing sibling name shows an error and keeps the original file", async ({
  page,
}) => {
  const a = `e2e-conf-${Date.now()}-a.txt`;
  const b = `e2e-conf-${Date.now()}-b.txt`;
  await uploadFile(page, a, "A");
  await uploadFile(page, b, "B");
  await page.goto("/files");

  const row = page
    .getByRole("button", { name: a })
    .first()
    .locator("../..");
  await row.hover();
  await row.locator('button[title="Rename"]').click({ force: true });

  const dialog = page.getByRole("dialog");
  const input = dialog.locator("input").first();
  await input.fill(b);
  await dialog.getByRole("button", { name: "Rename", exact: true }).click();

  // Dialog should stay open with the server error inline. "Destination
  // already exists" is the server's 409 copy from api.file-moves.$.ts.
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(/already exists/i),
  ).toBeVisible({ timeout: 5_000 });

  // Cancel to close the dialog, then assert both files still present.
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("button", { name: a }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: b }).first(),
  ).toBeVisible();

  await deleteFile(page, a);
  await deleteFile(page, b);
});

test("cancelling the rename dialog leaves the file name unchanged", async ({
  page,
}) => {
  const filename = `e2e-rencancel-${Date.now()}.txt`;
  await uploadFile(page, filename, "keep me");
  await page.goto("/files");

  const row = page
    .getByRole("button", { name: filename })
    .first()
    .locator("../..");
  await row.hover();
  await row.locator('button[title="Rename"]').click({ force: true });

  const dialog = page.getByRole("dialog");
  const input = dialog.locator("input").first();
  await input.fill("should-not-apply.txt");
  // Cancel without submitting.
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await expect(
    page.getByRole("button", { name: filename }).first(),
  ).toBeVisible();

  const res = await page.request.get(`/api/v1/files/${filename}`);
  expect(res.status()).toBe(200);

  await deleteFile(page, filename);
});

// ---------------------------------------------------------------------------
// Drag & drop upload
// ---------------------------------------------------------------------------

test("uploading a file via drag and drop", async ({ page }) => {
  const filename = `e2e-dnd-${Date.now()}.txt`;
  await page.goto("/files");

  // Create a DataTransfer with a file
  const dataTransfer = await page.evaluateHandle(
    ({ name, content }) => {
      const dt = new DataTransfer();
      const file = new File([content], name, { type: "text/plain" });
      dt.items.add(file);
      return dt;
    },
    { name: filename, content: "dropped content" },
  );

  // Dispatch drag events on the file list area
  const dropZone = page.locator(".relative").filter({ has: page.locator("button:has-text('Upload')") });
  await dropZone.dispatchEvent("dragenter", { dataTransfer });
  // Drop overlay should appear
  await expect(page.getByText("Drop here to upload")).toBeVisible({ timeout: 3_000 });

  await dropZone.dispatchEvent("drop", { dataTransfer });

  // File should appear after upload
  await expect(
    page.getByRole("button", { name: filename }).first(),
  ).toBeVisible({ timeout: 15_000 });

  await deleteFile(page, filename);
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Viewer: non-previewable file
// ---------------------------------------------------------------------------

test("files that cannot be previewed show a message", async ({
  page,
}) => {
  const filename = `e2e-binary-${Date.now()}.bin`;
  await uploadFile(page, filename, "\x00\x01\x02\x03");
  await page.goto("/files");

  await page.getByRole("button", { name: filename }).first().click();
  // Should show "cannot preview" message
  await expect(
    page.getByText("This file cannot be previewed"),
  ).toBeVisible({ timeout: 5_000 });

  // Download link should still be available
  const dialog = page.locator(".fixed.inset-0.z-50 > .relative.z-50");
  await expect(dialog.locator("a[download]")).toBeVisible();

  await page.getByRole("button", { name: "Close" }).click();
  await deleteFile(page, filename);
});

// ---------------------------------------------------------------------------
// Error: API failure shows error banner
// ---------------------------------------------------------------------------

test("an error banner is shown on API errors", async ({ page }) => {
  await page.goto("/files");

  // Intercept delete API to force a failure
  await page.route("**/api/v1/files/**", (route) => {
    if (route.request().method() === "DELETE") {
      return route.fulfill({ status: 500, body: "Internal Server Error" });
    }
    return route.continue();
  });

  const filename = `e2e-err-${Date.now()}.txt`;
  await uploadFile(page, filename, "error test");
  await page.reload();

  // Delete the file (will fail due to intercepted route)
  const row = page
    .getByRole("button", { name: filename })
    .first()
    .locator("../..");
  await row.hover();
  await row.locator('button[title="Delete"]').click({ force: true });
  await row.locator("button.bg-red-500").click();

  // Error banner should appear
  await expect(page.locator(".bg-red-50")).toBeVisible({ timeout: 5_000 });

  // Dismiss button should work
  await page.getByText("Dismiss").click();
  await expect(page.locator(".bg-red-50")).not.toBeVisible();

  // Remove route intercept and clean up
  await page.unroute("**/api/v1/files/**");
  await deleteFile(page, filename);
});
