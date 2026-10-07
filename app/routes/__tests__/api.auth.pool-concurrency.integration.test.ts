// pg.Pool({ max: 1 }) concurrency guard .
//
// A review raised a deadlock concern: the user.create.after
// hook calls `pool.connect()` while Better Auth may be holding the only
// client in the same pool. This test runs two concurrent sign-ups against
// a single auth instance (cached per env, one pg pool) — both must complete (no deadlock, no
// timeout) within the test budget. If the lock concern were real, this
// test would hang and Vitest would kill it on timeout.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanTestEnv,
  createTestEnv,
  disposeTestEnv,
  type TestEnv,
  testLoadContext,
} from "~/test/integration-helpers";

import { action } from "../api.auth.$";

let testEnv: TestEnv;

function ctx() {
  return testLoadContext(testEnv);
}

beforeAll(async () => {
  testEnv = await createTestEnv();
});

afterAll(async () => {
  await disposeTestEnv(testEnv);
});

beforeEach(async () => {
  await cleanTestEnv(testEnv);
});

describe("auth pool concurrency", () => {
  it("two concurrent sign-ups using the same auth instance both complete (no deadlock)", async () => {
    const signUp = (i: number) =>
      action({
        request: new Request("http://localhost/api/auth/sign-up/email", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Distinct IPs so Better Auth's per-IP rate limiter doesn't
            // throttle the second request.
            "x-s2-client-ip": `203.0.113.${100 + i}`,
          },
          body: JSON.stringify({
            email: `concurrent-${i}@example.com`,
            password: "correcthorsebatterystaple",
            name: `Concurrent ${i}`,
          }),
        }),
        context: ctx(),
        params: {},
      } as Parameters<typeof action>[0]);

    // Run with Promise.all so both sign-ups race through the user.create
    // hook simultaneously. If user.create.after deadlocked on the same
    // pg.Pool({ max: 1 }) Better Auth holds during /sign-up/email, this
    // test would hang past its timeout.
    const [r1, r2] = await Promise.all([signUp(1), signUp(2)]);
    expect([200, 201]).toContain(r1.status);
    expect([200, 201]).toContain(r2.status);

    const count = await testEnv.db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM "user"`,
    );
    expect(count?.cnt).toBe(2);
  }, 20_000); // 20s budget — plenty for two real sign-ups, well under hang.
});
