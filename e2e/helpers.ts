import fs from "node:fs";
import type { Page } from "@playwright/test";
import { AUTH_STATE_PATH, type AuthState } from "./global-setup";

// E2E auth uses a real Better Auth session cookie. globalSetup
// signs in the seeded test user exactly once via /api/auth/sign-in/email
// and writes the resulting cookie to AUTH_STATE_PATH. Tests load that
// cookie here and attach it to their page context — production sign-in
// (rate limit + DB session insert) is exercised once per run,
// then every test reuses the same session row. Doing the sign-in per test
// previously tripped Better Auth's rate limiter on the api project.

let cachedAuthState: AuthState | null = null;

function readAuthState(): AuthState {
  if (cachedAuthState) return cachedAuthState;
  let raw: string;
  try {
    raw = fs.readFileSync(AUTH_STATE_PATH, "utf8");
  } catch (err) {
    throw new Error(
      `E2E auth state missing at ${AUTH_STATE_PATH} — globalSetup must run first (${(err as Error).message})`,
    );
  }
  cachedAuthState = JSON.parse(raw) as AuthState;
  return cachedAuthState;
}

/**
 * Seed a real Better Auth session cookie on `page` so subsequent
 * `page.goto(...)` and `page.request.*` calls hit `/internal/*` /
 * `/api/v1/*` and dashboard routes as the seeded e2e test user.
 */
export async function setAuthCookie(page: Page): Promise<void> {
  const { cookieName, cookieValue } = readAuthState();
  const url = page.url();
  const baseURL =
    url && url !== "about:blank"
      ? new URL(url).origin
      : process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:8888";
  const { hostname } = new URL(baseURL);
  await page.context().addCookies([
    {
      name: cookieName,
      value: cookieValue,
      domain: hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

/** Upload a file via the API (test setup). */
export async function uploadFile(
  page: Page,
  filePath: string,
  content: string,
): Promise<void> {
  await setAuthCookie(page);
  const res = await page.request.put(`/api/v1/files/${filePath}`, {
    headers: { "Content-Type": "application/octet-stream" },
    data: content,
  });
  if (!res.ok()) throw new Error(`Upload failed: ${res.status()}`);
}

/** Create a folder via the API (test setup). */
export async function createFolder(
  page: Page,
  folderPath: string,
): Promise<void> {
  await setAuthCookie(page);
  const path = folderPath.endsWith("/") ? folderPath : `${folderPath}/`;
  await page.request.put(`/api/v1/files/${path}`, { data: "" });
}

/** Delete a file via the API (test cleanup). */
export async function deleteFile(page: Page, filePath: string): Promise<void> {
  await setAuthCookie(page);
  await page.request.delete(`/api/v1/files/${filePath}`);
}

export interface IssuedToken {
  id: string;
  raw_token: string;
}

/**
 * Issue a scoped token via POST /api/v1/tokens.
 * - Without parentRawToken: cookie auth (requires a page with setAuthCookie applied)
 * - With parentRawToken: uses that s2_... token as Bearer to issue a child token
 * Delete the token with deleteToken() when the test finishes.
 */
export async function issueToken(
  page: Page,
  opts: {
    name: string;
    base_path?: string;
    can_delegate?: boolean;
    access_paths?: Array<{ path: string; access: "read" | "write" }>;
    parentRawToken?: string;
  },
): Promise<IssuedToken> {
  if (!opts.parentRawToken) {
    await setAuthCookie(page);
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.parentRawToken) {
    headers.Authorization = `Bearer ${opts.parentRawToken}`;
  } else {
    headers.Origin = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:8888";
  }
  // POST /api/v1/tokens accepts both Bearer (delegation) and
  // session cookie (web UI), so a single URL covers both.
  const res = await page.request.post("/api/v1/tokens", {
    headers,
    data: JSON.stringify({
      name: opts.name,
      base_path: opts.base_path,
      can_delegate: opts.can_delegate ?? false,
      access_paths: opts.access_paths ?? [{ path: "", access: "write" }],
    }),
  });
  if (!res.ok()) throw new Error(`issueToken failed: ${res.status()} ${await res.text()}`);
  const body = await res.json() as { token: { id: string }; raw_token: string };
  return { id: body.token.id, raw_token: body.raw_token };
}

/**
 * Delete a token issued via POST /api/v1/tokens (test cleanup).
 * - Without parentRawToken: cookie auth (requires a page with setAuthCookie applied)
 * - With parentRawToken: uses that s2_... token as Bearer to delete
 */
export async function deleteToken(page: Page, tokenId: string, parentRawToken?: string): Promise<void> {
  if (!parentRawToken) {
    await setAuthCookie(page);
  }
  const headers: Record<string, string> = {};
  if (parentRawToken) {
    headers.Authorization = `Bearer ${parentRawToken}`;
  } else {
    headers.Origin = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:8888";
  }
  // DELETE /api/v1/tokens/:id accepts both Bearer and cookie auth.
  const res = await page.request.delete(`/api/v1/tokens/${tokenId}`, { headers });
  if (!res.ok() && res.status() !== 404) {
    throw new Error(`deleteToken failed: ${res.status()} ${await res.text()}`);
  }
}
