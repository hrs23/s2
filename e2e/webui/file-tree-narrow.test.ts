/**
 * Regression: file name disappeared in the desktop file
 * explorer when the viewport was narrow because every metadata column had
 * shrink-0 with a fixed width, so the name column shrank to 0 first.
 *
 * The fix drops metadata columns at narrower breakpoints (size: lg+,
 * tokens: xl+) so the name column always has room. These checks pin that
 * contract: at every breakpoint where the desktop layout is active, the
 * file name button must remain visible with a non-zero width.
 */
import { expect, test } from "@playwright/test";
import { deleteFile, setAuthCookie, uploadFile } from "../helpers";

const longName = "very-long-file-name-that-would-truncate-at-narrow-widths.txt";

// md=768 is the breakpoint where the desktop single-row layout takes over
// from the mobile two-row layout. Anything narrower already uses the
// mobile layout, which has a different (non-broken) shape.
const desktopWidths = [768, 900, 1024, 1280];

test.beforeEach(async ({ page }) => {
  await setAuthCookie(page);
});

for (const width of desktopWidths) {
  test(`file name stays visible at desktop width ${width}px`, async ({
    page,
  }) => {
    const filename = `narrow-${width}-${Date.now()}-${longName}`;
    await uploadFile(page, filename, "narrow viewport regression");

    await page.setViewportSize({ width, height: 800 });
    await page.goto("/files");

    const nameButton = page.getByRole("button", { name: filename }).first();
    await expect(nameButton).toBeVisible({ timeout: 10_000 });

    const box = await nameButton.boundingBox();
    expect(box, "name button must have a layout box").not.toBeNull();
    // The bug shrank this to ~0; require a clearly non-trivial width so a
    // future regression that almost-collapses the column also fails.
    expect(box?.width ?? 0).toBeGreaterThan(40);

    await deleteFile(page, filename);
  });
}
