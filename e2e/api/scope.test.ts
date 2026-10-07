/**
 * Scope (access_paths) restriction tests.
 *
 * base_path remaps the client's root — a token with base_path="/scoped/" sees
 * "/scoped/" as its "/". access_paths further restricts which paths within
 * base_path the token can read/write. These tests verify the access_paths
 * restriction by using base_path="/" and a limited access_paths set.
 */
import { expect, test } from "@playwright/test";
import { deleteToken, issueToken, setAuthCookie } from "../helpers";

const ALLOWED_FILE = "e2e-scope-allowed.txt";
const DENIED_FILE = "e2e-scope-denied.txt";

test.beforeEach(async ({ page }) => {
  await setAuthCookie(page);
});

test.afterEach(async ({ page }) => {
  // Cookie-only cleanup (no Bearer)
  await page.request.delete(`/api/v1/files/${ALLOWED_FILE}`);
  await page.request.delete(`/api/v1/files/${DENIED_FILE}`);
});

test("token with access_paths restriction can read/write allowed path", async ({ page, request }) => {
  const scoped = await issueToken(page, {
    name: "scope-allowed",
    base_path: "/",
    access_paths: [{ path: "allowed", access: "write" }],
  });

  try {
    // Use request fixture (no cookies) so Bearer is the only auth method
    const putRes = await request.put(`/api/v1/files/allowed/${ALLOWED_FILE}`, {
      headers: {
        Authorization: `Bearer ${scoped.raw_token}`,
        "Content-Type": "application/octet-stream",
      },
      data: "allowed content",
    });
    expect(putRes.status()).toBe(201);

    const getRes = await request.get(`/api/v1/files/allowed/${ALLOWED_FILE}`, {
      headers: { Authorization: `Bearer ${scoped.raw_token}` },
    });
    expect(getRes.status()).toBe(200);
    expect(await getRes.text()).toBe("allowed content");
  } finally {
    await request.delete(`/api/v1/files/allowed/${ALLOWED_FILE}`);
    await deleteToken(page, scoped.id);
  }
});

test("token with access_paths restriction gets 403 for denied path", async ({ page, request }) => {
  // Upload a file at root level with user session (cookie only)
  await page.request.put(`/api/v1/files/${DENIED_FILE}`, {
    headers: { "Content-Type": "application/octet-stream" },
    data: "root content",
  });

  const scoped = await issueToken(page, {
    name: "scope-denied",
    base_path: "/",
    access_paths: [{ path: "allowed", access: "write" }],
  });

  try {
    // Use request fixture (no cookies) so Bearer is the only auth method
    const readRes = await request.get(`/api/v1/files/${DENIED_FILE}`, {
      headers: { Authorization: `Bearer ${scoped.raw_token}` },
    });
    expect(readRes.status()).toBe(403);

    const writeRes = await request.put(`/api/v1/files/${DENIED_FILE}`, {
      headers: {
        Authorization: `Bearer ${scoped.raw_token}`,
        "Content-Type": "application/octet-stream",
      },
      data: "should be rejected",
    });
    expect(writeRes.status()).toBe(403);
  } finally {
    await deleteToken(page, scoped.id);
  }
});

test("/api/v1/token returns access_paths and hides base_path for scoped token", async ({ page, request }) => {
  const scoped = await issueToken(page, {
    name: "scope-token",
    base_path: "/docs/",
    access_paths: [{ path: "", access: "read" }],
  });

  try {
    // Use request fixture (no cookies) so Bearer is the only auth method
    const res = await request.get("/api/v1/token", {
      headers: { Authorization: `Bearer ${scoped.raw_token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.token_id).toBe(scoped.id);
    // token holders must not learn the absolute
    // position of their base_path. `access_paths` are relative to base_path
    // and always safe.
    expect(body.base_path).toBeUndefined();
    expect(body.access_paths).toEqual([{ path: "", access: "read" }]);
  } finally {
    await deleteToken(page, scoped.id);
  }
});
