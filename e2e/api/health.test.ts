import { expect, test } from "@playwright/test";

test("GET /health returns 200", async ({ request }) => {
  const res = await request.get("/health");
  expect(res.status()).toBe(200);
});
