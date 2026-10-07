// Sign-up flow guards: default API token seed, OAuth nOAuth
// defence in user.create.before.

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

// Each call uses a unique synthetic x-s2-client-ip so Better Auth's
// per-IP rate limiter (60s window in auth.server.ts) doesn't throttle
// successive test calls.
let ipSeq = 0;

function nextIp() {
  ipSeq += 1;
  return `203.0.113.${ipSeq}`;
}

async function signUp(extraHeaders: Record<string, string> = {}) {
  return action({
    request: new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-s2-client-ip": nextIp(),
        ...extraHeaders,
      },
      body: JSON.stringify({
        email: "new-user@example.com",
        password: "correcthorsebatterystaple",
        // The /signup UI sends `name: ""` — Better Auth accepts the empty
        // string and never derives the name from email. Mirrored here to
        // keep tests aligned with production behaviour.
        name: "",
        callbackURL: "/login?verified=1",
      }),
    }),
    context: ctx(),
    params: {},
  } as Parameters<typeof action>[0]);
}

describe("/sign-up/email", () => {
  it("seeds a Default API token alongside user_limits / user_storage", async () => {
    const res = await signUp();
    expect([200, 201]).toContain(res.status);

    const user = await testEnv.db.queryOne<{ id: string }>(
      `SELECT id FROM "user" WHERE email = $1`,
      ["new-user@example.com"],
    );
    expect(user).not.toBeNull();
    if (!user) throw new Error("signup did not create a user");

    // user_limits + user_storage seed (existing behaviour, kept as a
    // regression guard).
    const limits = await testEnv.db.queryOne<{
      user_id: string;
      storage_limit_bytes: number;
      grant_limit: number;
      revision_limit: number;
    }>(
      `SELECT user_id, storage_limit_bytes, grant_limit, revision_limit
         FROM user_limits WHERE user_id = $1`,
      [user.id],
    );
    expect(limits).toEqual({
      user_id: user.id,
      storage_limit_bytes: 0,
      grant_limit: 0,
      revision_limit: 0,
    });
    const storage = await testEnv.db.queryOne<{ user_id: string }>(
      `SELECT user_id FROM user_storage WHERE user_id = $1`,
      [user.id],
    );
    expect(storage).not.toBeNull();

    // Default API token (D01 §62) — single grant + path row at "/" with
    // the canonical "Default" name + can_delegate=true.
    const grants = await testEnv.db.query<{
      id: string;
      base_path: string;
    }>(
      `SELECT g.id, g.base_path
       FROM grants g
       WHERE g.user_id = $1`,
      [user.id],
    );
    expect(grants).toHaveLength(1);
    expect(grants[0].base_path).toBe("/");

    const userGrant = await testEnv.db.queryOne<{
      name: string;
      can_delegate: boolean;
    }>(`SELECT name, can_delegate FROM user_grants WHERE grant_id = $1`, [
      grants[0].id,
    ]);
    expect(userGrant?.name).toBe("Default");
    expect(userGrant?.can_delegate).toBe(true);

    const path = await testEnv.db.queryOne<{ access: string }>(
      `SELECT access FROM grant_paths WHERE grant_id = $1`,
      [grants[0].id],
    );
    expect(path?.access).toBe("write");
  });

  it("stores empty name when the UI omits it (no email-as-name fallback)", async () => {
    // The /signup form does not collect `name` and sends `name: ""`. Verify
    // the user row is created with `name = ''` rather than the email — guards
    // against a regression where email leaks into the name column.
    const res = await signUp();
    expect([200, 201]).toContain(res.status);

    const stored = await testEnv.db.queryOne<{ name: string; email: string }>(
      `SELECT name, email FROM "user" WHERE email = $1`,
      ["new-user@example.com"],
    );
    expect(stored?.name).toBe("");
    expect(stored?.name).not.toBe(stored?.email);
  });

  it("lower-cases email on sign-up but does NOT collapse Gmail dot/+tag variants", async () => {
    // Better Auth defaults: trim + toLowerCase. We deliberately do NOT
    // collapse Gmail dots or +tags — `Alice.Smith+tag@gmail.com` and
    // `alicesmith@gmail.com` are stored as distinct accounts.
    const res1 = await action({
      request: new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-s2-client-ip": nextIp(),
        },
        body: JSON.stringify({
          email: "Alice.Smith+tag@gmail.com",
          password: "correcthorsebatterystaple",
          name: "Alice",
        }),
      }),
      context: ctx(),
      params: {},
    } as Parameters<typeof action>[0]);
    expect([200, 201]).toContain(res1.status);

    // Better Auth lower-cases on its sign-up route. No further normalization.
    const stored = await testEnv.db.queryOne<{ email: string }>(
      `SELECT email FROM "user"`,
    );
    expect(stored?.email).toBe("alice.smith+tag@gmail.com");

    // A second sign-up with the dot/+tag-stripped form is treated as a
    // distinct account (two user rows total).
    const res2 = await action({
      request: new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-s2-client-ip": nextIp(),
        },
        body: JSON.stringify({
          email: "alicesmith@gmail.com",
          password: "correcthorsebatterystaple",
          name: "Alice 2",
        }),
      }),
      context: ctx(),
      params: {},
    } as Parameters<typeof action>[0]);
    expect([200, 201]).toContain(res2.status);

    const count = await testEnv.db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM "user"`,
    );
    expect(count?.cnt).toBe(2);
  });
});
