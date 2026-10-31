// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAuthContext } from "~/lib/auth/auth.server";
import {
  cleanTestEnv,
  createTestEnv,
  createTestUser,
  disposeTestEnv,
  sessionCookieHeader,
  type TestEnv,
} from "~/test/integration-helpers";

let testEnv: TestEnv;

beforeAll(async () => {
  testEnv = await createTestEnv();
});

afterAll(async () => {
  await disposeTestEnv(testEnv);
});

beforeEach(async () => {
  await cleanTestEnv(testEnv);
});

function cookieRequest(cookie: string): Request {
  return new Request("http://localhost/internal/account", {
    headers: { Cookie: cookie },
  });
}

describe("session revocation", () => {
  it("rejects a cached session once its DB row is deleted", async () => {
    const user = await createTestUser(testEnv.db);
    const cookie = await sessionCookieHeader(user.id, testEnv.env);

    await expect(
      getAuthContext(cookieRequest(cookie), testEnv.env),
    ).resolves.toEqual({ type: "user", user_id: user.id });

    await testEnv.db.execute('DELETE FROM "session" WHERE "userId" = $1', [
      user.id,
    ]);

    await expect(
      getAuthContext(cookieRequest(cookie), testEnv.env),
    ).resolves.toBeNull();
  });

  it("keeps other users' sessions valid", async () => {
    const revoked = await createTestUser(testEnv.db);
    const kept = await createTestUser(testEnv.db);
    await sessionCookieHeader(revoked.id, testEnv.env);
    const cookie = await sessionCookieHeader(kept.id, testEnv.env);

    await testEnv.db.execute('DELETE FROM "session" WHERE "userId" = $1', [
      revoked.id,
    ]);

    await expect(
      getAuthContext(cookieRequest(cookie), testEnv.env),
    ).resolves.toEqual({ type: "user", user_id: kept.id });
  });
});
