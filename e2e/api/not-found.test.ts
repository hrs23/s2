import { expect, test } from "@playwright/test";

// /api/v1/* is the public REST surface; the catch-all returns
// JSON 404 for unmatched paths under that prefix. /internal/* and other
// surfaces fall through to the React Router default handler (HTML).

test("GET /api/v1/unknown returns JSON 404 (not HTML)", async ({ request }) => {
  const res = await request.get("/api/v1/unknown-path", {
    headers: { Authorization: "Bearer s2_irrelevant" },
  });
  expect(res.status()).toBe(404);
  expect(res.headers()["content-type"]).toContain("application/json");
  const body = await res.json();
  expect(body).toEqual({
    error: { code: "not_found", message: "Not Found" },
  });
});

test("POST /api/v1/unknown returns JSON 404", async ({ request }) => {
  const res = await request.post("/api/v1/unknown-path", {
    data: {},
    headers: { Authorization: "Bearer s2_irrelevant" },
  });
  expect(res.status()).toBe(404);
  expect(res.headers()["content-type"]).toContain("application/json");
});
