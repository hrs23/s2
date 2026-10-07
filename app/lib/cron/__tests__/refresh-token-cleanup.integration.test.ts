import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbClient } from "~/lib/db/client.server";
import { FINITE_TEST_LIMITS, seedTestUser } from "~/test/integration-helpers";
import { createTestDb } from "~/test/test-db";
import { runRefreshTokenCleanup } from "../refresh-token-cleanup.server";

const USER = "user_cron_refresh_001";
const CLIENT = "client_cron_refresh_001";
const GRANT = "grant_cron_refresh_001";

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

async function insertToken(
  id: string,
  expiresAt: Date,
  opts: { revoked?: boolean; used?: boolean } = {},
) {
  // Schema enforces a partial UNIQUE on (grant_id) WHERE used_at IS NULL AND
  // revoked_at IS NULL. So we can have at most one *active* leaf per grant; we
  // set used_at / revoked_at in the same INSERT to slot many rows under one
  // grant for these tests.
  const usedAt = opts.used ? "now()" : "NULL";
  const revokedAt = opts.revoked ? "now()" : "NULL";
  const reason = opts.revoked ? "'reconsent'" : "NULL";
  await db.execute(
    `INSERT INTO refresh_tokens (id, grant_id, user_id, token_hash, expires_at, used_at, revoked_at, revocation_reason)
     SELECT $1, id, user_id, $3, $4, ${usedAt}, ${revokedAt}, ${reason}
     FROM grants WHERE id = $2`,
    [id, GRANT, `hash_${id}`, expiresAt],
  );
}

beforeEach(async () => {
  await db.execute("DELETE FROM refresh_tokens");
  await db.execute("DELETE FROM oauth_grants");
  await db.execute("DELETE FROM grants");
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
  await db.execute(
    `INSERT INTO grants (id, user_id, base_path) VALUES ($1, $2, '/')`,
    [GRANT, USER],
  );
  await db.execute(
    `INSERT INTO oauth_grants (grant_id, user_id, oauth_client_id, oauth_requested_scopes)
     VALUES ($1, $2, $3, ARRAY['files:read'])`,
    [GRANT, USER, CLIENT],
  );
});

describe("runRefreshTokenCleanup", () => {
  it("returns 0 when table is empty", async () => {
    const result = await runRefreshTokenCleanup(makeEnv());
    expect(result).toEqual({ deleted: 0 });
  });

  it("deletes expired tokens regardless of used_at / revoked_at", async () => {
    await insertToken("rt_expired_active", new Date(Date.now() - 60_000));
    await insertToken("rt_expired_used", new Date(Date.now() - 60_000), {
      used: true,
    });
    await insertToken("rt_expired_revoked", new Date(Date.now() - 60_000), {
      revoked: true,
    });

    const result = await runRefreshTokenCleanup(makeEnv());

    expect(result.deleted).toBe(3);
  });

  it("keeps live active / used tokens but removes revoked-but-live ones", async () => {
    const future = new Date(Date.now() + 60 * 60_000);
    await insertToken("rt_live_active", future);
    await insertToken("rt_live_used", future, { used: true });
    await insertToken("rt_live_revoked", future, { revoked: true });

    const result = await runRefreshTokenCleanup(makeEnv());

    // Revoked rows are deleted regardless of expires_at.
    expect(result.deleted).toBe(1);
    const remaining = await db.query<{ id: string }>(
      "SELECT id FROM refresh_tokens ORDER BY id",
    );
    expect(remaining.map((r) => r.id)).toEqual([
      "rt_live_active",
      "rt_live_used",
    ]);
  });

  it("removes a revoked row even when its expires_at is still in the future", async () => {
    const future = new Date(Date.now() + 60 * 60_000);
    await insertToken("rt_revoked_live", future, { revoked: true });

    const result = await runRefreshTokenCleanup(makeEnv());

    expect(result.deleted).toBe(1);
    const remaining = await db.query<{ id: string }>(
      "SELECT id FROM refresh_tokens",
    );
    expect(remaining).toEqual([]);
  });

  it("only removes expired or revoked rows when active rows coexist", async () => {
    await insertToken("rt_expired", new Date(Date.now() - 60_000));
    await insertToken(
      "rt_live",
      new Date(Date.now() + 60 * 60_000),
      { used: true }, // marked used so the active partial UNIQUE is free
    );

    const result = await runRefreshTokenCleanup(makeEnv());

    expect(result.deleted).toBe(1);
    const remaining = await db.query<{ id: string }>(
      "SELECT id FROM refresh_tokens",
    );
    expect(remaining.map((r) => r.id)).toEqual(["rt_live"]);
  });
});
