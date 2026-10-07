import fs from "node:fs";
import path from "node:path";
import { hashPassword } from "better-auth/crypto";
import pg from "pg";
import { cleanupDevVars } from "./ensure-dev-vars";

// E2E seeding writes to Better Auth's `"user"` + `account` tables
// plus the s2-owned side tables (user_limits / user_storage) and the
// scoped-token primitives (grants / user_grants / grant_paths /
// access_tokens). After seeding we also mint exactly one Better Auth
// session via /api/auth/sign-in/email and persist its cookie to
// AUTH_STATE_PATH so helpers.ts can attach it to every page without
// re-driving sign-in (which trips Better Auth's rate limiter).

const TEST_USER_ID = "e2e-test-user-fixed-id";
const TEST_USER_EMAIL = "e2e-test@example.com";
const TEST_USER_PASSWORD = "e2e-test-password-12345";
const TEST_TOKEN_ID = "e2e-test-token-fixed-id";

export const AUTH_STATE_PATH = path.resolve(
  process.cwd(),
  "e2e/test-results/auth-state.json",
);

export interface AuthState {
  cookieName: string;
  cookieValue: string;
}

const DB_URL =
  process.env.E2E_DB_URL ?? "postgres://postgres:postgres@localhost:5432/s2";

/**
 * Warm up the app server by hitting public routes used in e2e tests.
 */
async function warmupApp(baseURL: string) {
  for (const route of ["/login", "/docs"]) {
    try {
      await fetch(`${baseURL}${route}`);
    } catch {
      // ignore — best-effort warmup
    }
  }
}

/**
 * Mint exactly one Better Auth session for the seeded e2e user and write
 * the resulting `name=value` cookie line to AUTH_STATE_PATH. helpers.ts
 * reads this file from every test, so we hit /api/auth/sign-in/email a
 * single time per run and never collide with Better Auth's rate limiter.
 */
async function mintAuthState(baseURL: string) {
  const res = await fetch(`${baseURL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Better Auth's `trustedOrigins` CSRF check requires a same-origin Origin.
      Origin: baseURL,
    },
    body: JSON.stringify({
      email: TEST_USER_EMAIL,
      password: TEST_USER_PASSWORD,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `[E2E globalSetup] sign-in failed: ${res.status} ${await res.text()}`,
    );
  }
  // Node fetch's headers.getSetCookie() returns each Set-Cookie line
  // separately (unlike the legacy single-string header).
  const setCookies = res.headers.getSetCookie();
  const sessionLine = setCookies.find((line) => line.includes("session_token"));
  if (!sessionLine) {
    throw new Error(
      "[E2E globalSetup] sign-in returned no Better Auth session cookie",
    );
  }
  const [namePart] = sessionLine.split(";", 1);
  const eq = namePart.indexOf("=");
  if (eq <= 0) {
    throw new Error(`[E2E globalSetup] malformed Set-Cookie: ${sessionLine}`);
  }
  const state: AuthState = {
    cookieName: namePart.slice(0, eq),
    cookieValue: namePart.slice(eq + 1),
  };
  fs.mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });
  fs.writeFileSync(AUTH_STATE_PATH, JSON.stringify(state));
  console.log("[E2E globalSetup] auth state cached:", state.cookieName);
}

async function withDb<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(DB_URL);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export default async function globalSetup() {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:8888";

  await withDb(async (client) => {
    // Better Auth's `account` row carries the password hash for
    // email/password sign-in. We pre-compute it so the helper can call
    // /api/auth/sign-in/email and get a real session cookie.
    const passwordHash = await hashPassword(TEST_USER_PASSWORD);
    const now = new Date().toISOString();

    // 1. Better Auth user row (emailVerified=true so the user can reach
    // protected routes without going through the link click).
    await client.query(
      `INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, true, $4, $4)
       ON CONFLICT (id) DO UPDATE SET "emailVerified" = true`,
      [TEST_USER_ID, TEST_USER_EMAIL, "E2E Test User", now],
    );

    // 2. Better Auth account row (credential provider — password hash).
    await client.query(
      `INSERT INTO "account" (id, "accountId", "providerId", "userId",
                              password, "createdAt", "updatedAt")
       VALUES ($1, $2, 'credential', $2, $3, $4, $4)
       ON CONFLICT (id) DO UPDATE SET password = EXCLUDED.password`,
      [`acct_${TEST_USER_ID}`, TEST_USER_ID, passwordHash, now],
    );

    // 3. s2 side tables.
    await client.query(
      `INSERT INTO user_limits (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [TEST_USER_ID],
    );
    await client.query(
      `INSERT INTO user_storage (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [TEST_USER_ID],
    );

    // 4. Default scoped token (Bearer credential for /api/v1 tests).
    await client.query(
      `INSERT INTO grants (id, user_id, base_path)
       VALUES ($1, $2, '/')
       ON CONFLICT (id) DO NOTHING`,
      [TEST_TOKEN_ID, TEST_USER_ID],
    );
    await client.query(
      `INSERT INTO user_grants (grant_id, user_id, name, can_delegate)
       VALUES ($1, $2, 'Default', true)
       ON CONFLICT (grant_id) DO NOTHING`,
      [TEST_TOKEN_ID, TEST_USER_ID],
    );
    // Access paths are base_path-relative
    // and "" is the canonical root (no leading slash).
    await client.query(
      `INSERT INTO grant_paths (grant_id, path, access)
       VALUES ($1, '', 'write')
       ON CONFLICT DO NOTHING`,
      [TEST_TOKEN_ID],
    );

    console.log(
      "[E2E globalSetup] Better Auth user + side tables seeded:",
      TEST_USER_EMAIL,
    );
  });

  await warmupApp(baseURL);
  await mintAuthState(baseURL);

  return async () => {
    try {
      await withDb(async (client) => {
        // CASCADE through "user"(id) wipes session / account / grants
        // / user_limits / user_storage automatically.
        await client.query(`DELETE FROM "user" WHERE id = $1`, [TEST_USER_ID]);
        console.log("[E2E globalTeardown] Deleted test user");
      });
    } catch (e) {
      console.warn("[E2E globalTeardown] Cleanup failed:", e);
    }
    try {
      fs.unlinkSync(AUTH_STATE_PATH);
    } catch {
      // best-effort
    }
    cleanupDevVars();
  };
}
