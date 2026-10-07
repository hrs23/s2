import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "~/lib/db/client.server";
import { FINITE_TEST_LIMITS, seedTestUser } from "~/test/integration-helpers";
import { createTestDb } from "~/test/test-db";
import { runAuthzCodeCleanup } from "../authz-code-cleanup.server";

const USER = "user_cron_authz_001";
const CLIENT = "client_cron_authz_001";

let db: DbClient;

beforeAll(async () => {
  db = await createTestDb();
});

function makeEnv(): Env {
  return {
    DATABASE_URL: "postgres://stub:stub@stub:5432/stub",
    __testDbClient: db,
  } as unknown as Env;
}

async function insertCode(codeHash: string, expiresAt: Date) {
  await db.execute(
    `INSERT INTO oauth_authorization_codes
       (code_hash, client_id, user_id, redirect_uri, scopes,
        code_challenge, code_challenge_method,
        base_path, consent_paths, expires_at)
     VALUES ($1, $2, $3, 'https://example.com/cb', ARRAY['files:read'],
             'challenge', 'S256', '/',
             '[{"path":"/","access":"read"}]'::jsonb, $4)`,
    [codeHash, CLIENT, USER, expiresAt],
  );
}

beforeEach(async () => {
  // Order matters because of FK CASCADE chains.
  await db.execute("DELETE FROM oauth_authorization_codes");
  await db.execute("DELETE FROM oauth_clients");
  await db.execute(`DELETE FROM "user"`);
  await seedTestUser(db, {
    id: USER,
    email: `${USER}@test.local`,
    limits: FINITE_TEST_LIMITS,
    bytesUsed: 0,
  });
  await db.execute(
    `INSERT INTO oauth_clients (id, client_name, redirect_uris, token_endpoint_auth_method)
     VALUES ($1, 'cron-test', ARRAY['https://example.com/cb'], 'none')`,
    [CLIENT],
  );
});

describe("runAuthzCodeCleanup", () => {
  it("returns 0 when table is empty", async () => {
    const result = await runAuthzCodeCleanup(makeEnv());
    expect(result).toEqual({ deleted: 0 });
  });

  it("deletes expired codes and keeps live ones", async () => {
    await insertCode("hash_expired_1", new Date(Date.now() - 60_000));
    await insertCode("hash_expired_2", new Date(Date.now() - 1_000));
    await insertCode("hash_live", new Date(Date.now() + 60_000));

    const result = await runAuthzCodeCleanup(makeEnv());

    expect(result.deleted).toBe(2);
    const remaining = await db.query<{ code_hash: string }>(
      "SELECT code_hash FROM oauth_authorization_codes",
    );
    expect(remaining.map((r) => r.code_hash)).toEqual(["hash_live"]);
  });

  it("deletes expired codes regardless of used_at", async () => {
    // A code can be `used_at IS NOT NULL` but still expired — both are dead.
    // The cleanup should treat them uniformly so the partial expires_at index
    // can also be pruned of legitimate-but-expired rows.
    await insertCode("hash_used_expired", new Date(Date.now() - 60_000));
    await db.execute(
      "UPDATE oauth_authorization_codes SET used_at = now() WHERE code_hash = $1",
      ["hash_used_expired"],
    );

    const result = await runAuthzCodeCleanup(makeEnv());

    expect(result.deleted).toBe(1);
  });
});
