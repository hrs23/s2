import { expect, test } from "@playwright/test";
import { setAuthCookie } from "../helpers";

test("GET /api/v1/token returns 401 without auth", async ({ request }) => {
  const res = await request.get("/api/v1/token");
  expect(res.status()).toBe(401);
});

test("GET /internal/account returns 401 without auth", async ({ request }) => {
  const res = await request.get("/internal/account");
  expect(res.status()).toBe(401);
});

test("GET /internal/account returns user info with session cookie", async ({
  page,
}) => {
  await setAuthCookie(page);
  const res = await page.request.get("/internal/account");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.user_id).toBeTruthy();
});

test("/internal/account ignores Bearer (rejected by middleware)", async ({
  request,
}) => {
  // app/lib/gateway/middleware.ts forbids Authorization on /internal/* with 403.
  const res = await request.get("/internal/account", {
    headers: { Authorization: "Bearer s2_irrelevant" },
  });
  expect(res.status()).toBe(403);
});

test("/api/v1/token rejects session cookie with 403 (Bearer-only surface)", async ({
  page,
  request,
}) => {
  // prefix-aware resolver — /api/v1/token accepts only Bearer s2_*.
  // A valid session cookie authenticates the user but lands on the wrong
  // surface, so the loader returns 403 ("Bearer token required") rather
  // than 401. We seed the page with a real Better Auth cookie, then carry
  // it through the cookie-less `request` fixture's Cookie header.
  await setAuthCookie(page);
  const cookies = await page.context().cookies();
  const cookieHeader = cookies
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const res = await request.get("/api/v1/token", {
    headers: { Cookie: cookieHeader },
  });
  expect(res.status()).toBe(403);
});
