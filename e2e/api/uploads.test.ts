import { expect, test } from "@playwright/test";
import { setAuthCookie } from "../helpers";

test("upload session lifecycle: create → chunk → complete", async ({ page }) => {
  await setAuthCookie(page);

  const filePath = "e2e-api-uploads-test.bin";
  const content = "upload session test content";
  const contentBytes = Buffer.from(content);

  // Create session
  const createRes = await page.request.post("/api/v1/uploads", {
    data: { path: filePath, totalSize: contentBytes.length },
  });
  expect(createRes.status()).toBe(201);
  const { sessionId } = await createRes.json();
  expect(sessionId).toBeTruthy();

  // Upload chunk
  const chunkRes = await page.request.put(`/api/v1/uploads/${sessionId}/0`, {
    headers: { "Content-Type": "application/octet-stream" },
    data: contentBytes,
  });
  expect(chunkRes.status()).toBe(200);

  // Complete
  const completeRes = await page.request.post(`/api/v1/uploads/${sessionId}/complete`);
  expect(completeRes.status()).toBe(200);

  // Verify file is accessible
  const getRes = await page.request.get(`/api/v1/files/${filePath}`);
  expect(getRes.status()).toBe(200);
  expect(await getRes.text()).toBe(content);

  // Cleanup
  await page.request.delete(`/api/v1/files/${filePath}`);
});

test("DELETE /api/v1/uploads/:id cancels a session", async ({ page }) => {
  await setAuthCookie(page);

  const createRes = await page.request.post("/api/v1/uploads", {
    data: { path: "e2e-api-uploads-cancel.bin", totalSize: 1024 },
  });
  expect(createRes.status()).toBe(201);
  const { sessionId } = await createRes.json();

  const cancelRes = await page.request.delete(`/api/v1/uploads/${sessionId}`);
  expect(cancelRes.status()).toBe(204);
});
