import { expect, test } from "@playwright/test";

const viewports = {
	mobile: { width: 375, height: 667 },
	desktop: { width: 1280, height: 800 },
} as const;

const publicPages = [
	{ name: "docs", path: "/docs", waitFor: "header" },
	{ name: "docs-mcp", path: "/docs/mcp", waitFor: "header" },
] as const;

for (const { name, path, waitFor } of publicPages) {
	for (const [viewport, size] of Object.entries(viewports)) {
		test(`${name} - ${viewport}`, async ({ page }) => {
			await page.setViewportSize(size);
			await page.goto(path);
			await page.locator(waitFor).first().waitFor();
			await expect(page).toHaveScreenshot(`${name}-${viewport}.png`);
		});
	}
}
