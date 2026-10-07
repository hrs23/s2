import { expect, test } from "@playwright/test";
import { setAuthCookie } from "../helpers";

const FILE_PATH = "e2e-api-files-test.txt";
const FILE_CONTENT = "hello from e2e api test";

test.beforeEach(async ({ page }) => {
  await setAuthCookie(page);
});

test.afterEach(async ({ page }) => {
  await page.request.delete(`/api/v1/files/${FILE_PATH}`);
});

// HTTP smoke test; detailed behavior is covered by the integration tests.
test("upload, download and delete round trip", async ({ page }) => {
  const put = await page.request.put(`/api/v1/files/${FILE_PATH}`, {
    headers: { "Content-Type": "application/octet-stream" },
    data: FILE_CONTENT,
  });
  expect(put.status()).toBe(201);

  const get = await page.request.get(`/api/v1/files/${FILE_PATH}`);
  expect(get.status()).toBe(200);
  expect(await get.text()).toBe(FILE_CONTENT);

  const del = await page.request.delete(`/api/v1/files/${FILE_PATH}`);
  expect(del.status()).toBe(204);
});
