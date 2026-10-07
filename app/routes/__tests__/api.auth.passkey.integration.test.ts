// Passkey plugin integration.
//
// Drives the @better-auth/passkey plugin via the /api/auth/* HTTP boundary
// against the real (PGlite-backed) Better Auth instance. We don't run the
// full WebAuthn cryptographic ceremony — SimpleWebAuthn's own test suite
// covers that, and the spike report (§"Caveats") explicitly defers ceremony
// validation to the Playwright virtual-authenticator E2E. What this file
// verifies:
//
//   1. The plugin is wired and exposes /api/auth/passkey/* endpoints
//      (generate-register-options requires a session and returns the right
//      rpID derived from APP_URL).
//   2. The `passkey` table physically holds rows (we seed via SQL since
//      verify-registration needs a real attestation) and the
//      list-user-passkeys endpoint surfaces them through Better Auth.
//   3. Deleting a passkey via the plugin API removes the row.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanTestEnv,
  createTestEnv,
  createTestUser,
  disposeTestEnv,
  sessionCookieHeader,
  type TestEnv,
  testLoadContext,
} from "~/test/integration-helpers";
import { action, loader } from "../api.auth.$";

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

let ipSeq = 0;
function nextIp() {
  ipSeq += 1;
  return `203.0.113.${ipSeq}`;
}

async function authedUser(): Promise<{ userId: string; cookie: string }> {
  const user = await createTestUser(testEnv.db);
  const cookie = await sessionCookieHeader(user.id, testEnv.env);
  return { userId: user.id, cookie };
}

describe("/api/auth/passkey/*", () => {
  it("generate-register-options requires a session", async () => {
    const res = await loader({
      request: new Request(
        "http://localhost/api/auth/passkey/generate-register-options",
        {
          method: "GET",
          headers: { "x-s2-client-ip": nextIp() },
        },
      ),
      context: ctx(),
      params: {},
    } as Parameters<typeof loader>[0]);
    expect(res.status).toBe(401);
  });

  it("generate-register-options returns PublicKeyCredentialCreationOptions with rpID derived from APP_URL", async () => {
    const { cookie } = await authedUser();
    const res = await loader({
      request: new Request(
        "http://localhost/api/auth/passkey/generate-register-options",
        {
          method: "GET",
          headers: { cookie, "x-s2-client-ip": nextIp() },
        },
      ),
      context: ctx(),
      params: {},
    } as Parameters<typeof loader>[0]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      challenge?: string;
      rp?: { id?: string; name?: string };
      pubKeyCredParams?: unknown[];
      user?: { id?: string };
    };
    expect(body.challenge).toBeTypeOf("string");
    // env.APP_URL = http://localhost:8888 → hostname "localhost"
    expect(body.rp?.id).toBe("localhost");
    expect(body.rp?.name).toBe("S2");
    expect(Array.isArray(body.pubKeyCredParams)).toBe(true);
  });

  it("list-user-passkeys returns rows seeded for the authed user", async () => {
    const { userId, cookie } = await authedUser();

    await testEnv.db.execute(
      `INSERT INTO "passkey"
       (id, name, "publicKey", "userId", "credentialID", counter, "deviceType", "backedUp", transports, "createdAt", aaguid)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10)`,
      [
        "pk_1",
        "MacBook",
        "stub-public-key-1",
        userId,
        "cred-id-1",
        0,
        "multiDevice",
        true,
        "internal,hybrid",
        "0a0b0c0d-0a0b-0c0d-0a0b-0c0d0e0f1011",
      ],
    );
    await testEnv.db.execute(
      `INSERT INTO "passkey"
       (id, name, "publicKey", "userId", "credentialID", counter, "deviceType", "backedUp", transports, "createdAt", aaguid)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10)`,
      [
        "pk_2",
        "iPhone",
        "stub-public-key-2",
        userId,
        "cred-id-2",
        0,
        "multiDevice",
        true,
        "internal",
        "11111111-2222-3333-4444-555555555555",
      ],
    );

    const res = await loader({
      request: new Request(
        "http://localhost/api/auth/passkey/list-user-passkeys",
        {
          method: "GET",
          headers: { cookie, "x-s2-client-ip": nextIp() },
        },
      ),
      context: ctx(),
      params: {},
    } as Parameters<typeof loader>[0]);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ id: string; name: string }>;
    expect(list).toHaveLength(2);
    const names = list.map((p) => p.name).sort();
    expect(names).toEqual(["MacBook", "iPhone"].sort());
  });

  it("delete-passkey removes the row", async () => {
    const { userId, cookie } = await authedUser();

    await testEnv.db.execute(
      `INSERT INTO "passkey"
       (id, name, "publicKey", "userId", "credentialID", counter, "deviceType", "backedUp", transports, "createdAt", aaguid)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10)`,
      [
        "pk_to_delete",
        "Laptop",
        "stub-public-key",
        userId,
        "cred-id",
        0,
        "multiDevice",
        true,
        "internal",
        "00000000-0000-0000-0000-000000000000",
      ],
    );

    const res = await action({
      request: new Request("http://localhost/api/auth/passkey/delete-passkey", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie,
          "x-s2-client-ip": nextIp(),
        },
        body: JSON.stringify({ id: "pk_to_delete" }),
      }),
      context: ctx(),
      params: {},
    } as Parameters<typeof action>[0]);
    expect(res.status).toBe(200);

    const row = await testEnv.db.queryOne<{ id: string }>(
      `SELECT id FROM "passkey" WHERE id = $1`,
      ["pk_to_delete"],
    );
    expect(row).toBeNull();
  });
});

describe("/api/auth/passkey/* when PASSKEY_ENABLED=false", () => {
  afterEach(() => {
    delete (testEnv.env as { PASSKEY_ENABLED?: string }).PASSKEY_ENABLED;
  });

  it("does not expose passkey endpoints", async () => {
    testEnv.env = { ...testEnv.env, PASSKEY_ENABLED: "false" };
    const { cookie } = await authedUser();
    const res = await loader({
      request: new Request(
        "http://localhost/api/auth/passkey/generate-register-options",
        {
          method: "GET",
          headers: { cookie, "x-s2-client-ip": nextIp() },
        },
      ),
      context: ctx(),
      params: {},
    } as Parameters<typeof loader>[0]);
    expect(res.status).toBe(404);
  });
});
