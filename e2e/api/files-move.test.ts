import { expect, test } from "@playwright/test";
import { setAuthCookie } from "../helpers";

const SRC_PATH = "e2e-api-file-moves-src.txt";
const DST_PATH = "e2e-api-file-moves-dst.txt";

test.beforeEach(async ({ page }) => {
  await setAuthCookie(page);
});

test.afterEach(async ({ page }) => {
  await page.request.delete(`/api/v1/files/${SRC_PATH}`);
  await page.request.delete(`/api/v1/files/${DST_PATH}`);
});

test("POST /api/v1/files-move moves a file", async ({ page }) => {
  await page.request.put(`/api/v1/files/${SRC_PATH}`, {
    headers: { "Content-Type": "application/octet-stream" },
    data: "move test content",
  });

  // collection-resource shape — body carries `{from, to}` instead
  // of encoding the source in the URL.
  const res = await page.request.post(`/api/v1/files-move`, {
    headers: { "Content-Type": "application/json" },
    data: JSON.stringify({ from: SRC_PATH, to: DST_PATH }),
  });
  expect(res.status()).toBe(200);

  // Verify moved
  const srcRes = await page.request.get(`/api/v1/files/${SRC_PATH}`);
  expect(srcRes.status()).toBe(404);

  const dstRes = await page.request.get(`/api/v1/files/${DST_PATH}`);
  expect(dstRes.status()).toBe(200);
  expect(await dstRes.text()).toBe("move test content");
});
