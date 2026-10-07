// @vitest-environment node
//
// OAuthGrantRepository integration tests — focus on cross-user isolation
// (pre-RLS guard).
//
// oauth_grants rows have a composite FK (grant_id, user_id) → grants
// (id, user_id), so a row's user_id is structurally bound to the owning
// grants row. These tests pin both:
//
//   1. CRUD basics (create / findById / findByUserClient / updateOnReconsent)
//   2. cross-user lookups: user B passing user A's identifiers must miss
//
// findById() does NOT take a user_id argument — that is by design (used by
// the OAuth refresh flow, where the refresh_token hash is the security
// boundary). The cross-user test here documents that the row's user_id
// stays bound to A even when B initiates the lookup, so the caller can
// compare against its auth context.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TokenRepository } from "~/lib/auth/token-repository.server";
import {
  asTestTx,
  cleanTestEnv,
  createTestEnv,
  createTestUser,
  disposeTestEnv,
  type TestEnv,
} from "~/test/integration-helpers";
import { OAuthGrantRepository } from "../oauth-grant-repository.server";

let tx: ReturnType<typeof asTestTx>;

let testEnv: TestEnv;
let repo: OAuthGrantRepository;
let tokenRepo: TokenRepository;

const USER_A = "user_oauth_grant_a";
const USER_B = "user_oauth_grant_b";
const CLIENT_X = "oauth_client_x";
const CLIENT_Y = "oauth_client_y";

beforeAll(async () => {
  testEnv = await createTestEnv();
  tx = asTestTx(testEnv.db);
});

afterAll(async () => {
  await disposeTestEnv(testEnv);
});

beforeEach(async () => {
  await cleanTestEnv(testEnv);
  await createTestUser(testEnv.db, { id: USER_A });
  await createTestUser(testEnv.db, { id: USER_B });

  // Seed two OAuth clients (DCR rows). Tests that need only one will use X.
  await testEnv.db.execute(
    `INSERT INTO oauth_clients (id, client_name, redirect_uris, token_endpoint_auth_method)
     VALUES ($1, 'Client X', ARRAY['http://127.0.0.1/cb'], 'none'),
            ($2, 'Client Y', ARRAY['http://127.0.0.1/cb'], 'none')`,
    [CLIENT_X, CLIENT_Y],
  );

  repo = new OAuthGrantRepository();
  tokenRepo = new TokenRepository(testEnv.db);
});

// Helper: create an oauth grant for a given user/client.
async function seedGrant(opts: {
  grantId: string;
  userId: string;
  clientId: string;
  basePath?: string;
  resource?: string | null;
  scopes?: ReadonlyArray<string>;
}): Promise<void> {
  await repo.create(
    {
      grantId: opts.grantId,
      userId: opts.userId,
      basePath: opts.basePath ?? "/",
      createdAt: new Date().toISOString(),
      oauthClientId: opts.clientId,
      oauthRequestedScopes: opts.scopes ?? ["files"],
      resource: opts.resource ?? null,
    },
    tx,
  );
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("create", () => {
  it("inserts both grants and oauth_grants rows", async () => {
    await seedGrant({
      grantId: "grant_create_1",
      userId: USER_A,
      clientId: CLIENT_X,
      basePath: "/docs",
      resource: "https://api.example.com",
      scopes: ["files", "openid"],
    });

    const grant = await repo.findById("grant_create_1", tx);
    expect(grant).toEqual({
      grant_id: "grant_create_1",
      user_id: USER_A,
      oauth_client_id: CLIENT_X,
      oauth_requested_scopes: ["files", "openid"],
      resource: "https://api.example.com",
    });

    // grants row exists too (composite FK guarantees user match)
    expect(await tokenRepo.countByUser(USER_A, tx)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// findByUserClient
// ---------------------------------------------------------------------------

describe("findByUserClient", () => {
  it("returns the grant when (user, client) match", async () => {
    await seedGrant({
      grantId: "grant_uc_1",
      userId: USER_A,
      clientId: CLIENT_X,
    });

    const found = await repo.findByUserClient(USER_A, CLIENT_X, tx);
    expect(found?.grant_id).toBe("grant_uc_1");
    expect(found?.user_id).toBe(USER_A);
  });

  it("returns null when client_id does not match", async () => {
    await seedGrant({
      grantId: "grant_uc_2",
      userId: USER_A,
      clientId: CLIENT_X,
    });

    const found = await repo.findByUserClient(USER_A, CLIENT_Y, tx);
    expect(found).toBeNull();
  });

  it("returns null when user_id does not match (cross-user)", async () => {
    // A grants Client X access — B querying for the same client must miss.
    await seedGrant({
      grantId: "grant_uc_xuser",
      userId: USER_A,
      clientId: CLIENT_X,
    });

    const found = await repo.findByUserClient(USER_B, CLIENT_X, tx);
    expect(found).toBeNull();
  });

  it("isolates two users granting the same client independently", async () => {
    await seedGrant({
      grantId: "grant_uc_a",
      userId: USER_A,
      clientId: CLIENT_X,
      resource: "res-a",
    });
    await seedGrant({
      grantId: "grant_uc_b",
      userId: USER_B,
      clientId: CLIENT_X,
      resource: "res-b",
    });

    const aFound = await repo.findByUserClient(USER_A, CLIENT_X, tx);
    expect(aFound?.grant_id).toBe("grant_uc_a");
    expect(aFound?.resource).toBe("res-a");

    const bFound = await repo.findByUserClient(USER_B, CLIENT_X, tx);
    expect(bFound?.grant_id).toBe("grant_uc_b");
    expect(bFound?.resource).toBe("res-b");
  });
});

// ---------------------------------------------------------------------------
// findById
// ---------------------------------------------------------------------------

describe("findById", () => {
  it("returns the grant by id", async () => {
    await seedGrant({
      grantId: "grant_find_1",
      userId: USER_A,
      clientId: CLIENT_X,
    });

    const found = await repo.findById("grant_find_1", tx);
    expect(found?.grant_id).toBe("grant_find_1");
    expect(found?.user_id).toBe(USER_A);
  });

  it("returns null for missing grant", async () => {
    const found = await repo.findById("nonexistent", tx);
    expect(found).toBeNull();
  });

  // Cross-user contract: findById has no user_id argument by design (the
  // OAuth refresh flow's security boundary is the refresh_token hash).
  // This test pins that the returned row's user_id never lies about
  // ownership — callers MUST compare row.user_id to their auth context.
  it("returned user_id is the row owner regardless of caller (no user filter by design)", async () => {
    await seedGrant({
      grantId: "grant_find_xuser",
      userId: USER_A,
      clientId: CLIENT_X,
    });

    const found = await repo.findById("grant_find_xuser", tx);
    // user_id is stable — it's the row owner. The OAuthService caller
    // compares this to its auth context before acting on it.
    expect(found?.user_id).toBe(USER_A);
    expect(found?.user_id).not.toBe(USER_B);
  });
});

// ---------------------------------------------------------------------------
// updateOnReconsent
// ---------------------------------------------------------------------------

describe("updateOnReconsent", () => {
  it("refreshes scopes and resource on the targeted grant", async () => {
    await seedGrant({
      grantId: "grant_rc_1",
      userId: USER_A,
      clientId: CLIENT_X,
      scopes: ["files"],
      resource: null,
    });

    await repo.updateOnReconsent(
      "grant_rc_1",
      {
        oauthRequestedScopes: ["files", "openid"],
        resource: "https://api.example.com",
      },
      tx,
    );

    const updated = await repo.findById("grant_rc_1", tx);
    expect(updated?.oauth_requested_scopes).toEqual(["files", "openid"]);
    expect(updated?.resource).toBe("https://api.example.com");
    // Identity fields untouched
    expect(updated?.user_id).toBe(USER_A);
    expect(updated?.oauth_client_id).toBe(CLIENT_X);
  });

  // Cross-user contract: updateOnReconsent takes only grantId. Caller is
  // responsible for verifying the grant belongs to the acting user. The
  // OAuthService consent path resolves the grantId via findByUserClient
  // (which IS user-filtered) before calling updateOnReconsent. This test
  // documents that B cannot accidentally mutate A's grant via this method
  // unless the upstream caller already failed to filter.
  it("does not mutate other users' grants (only the grant_id passed is touched)", async () => {
    await seedGrant({
      grantId: "grant_rc_a",
      userId: USER_A,
      clientId: CLIENT_X,
      scopes: ["files"],
      resource: "res-a",
    });
    await seedGrant({
      grantId: "grant_rc_b",
      userId: USER_B,
      clientId: CLIENT_X,
      scopes: ["files"],
      resource: "res-b",
    });

    await repo.updateOnReconsent(
      "grant_rc_a",
      {
        oauthRequestedScopes: ["files", "openid"],
        resource: "res-a-new",
      },
      tx,
    );

    const aAfter = await repo.findById("grant_rc_a", tx);
    const bAfter = await repo.findById("grant_rc_b", tx);

    expect(aAfter?.oauth_requested_scopes).toEqual(["files", "openid"]);
    expect(aAfter?.resource).toBe("res-a-new");

    // B's grant must be unchanged — proves the WHERE grant_id = $1 is
    // narrowly scoped and there's no accidental broader update.
    expect(bAfter?.oauth_requested_scopes).toEqual(["files"]);
    expect(bAfter?.resource).toBe("res-b");
  });

  it("no-op for a non-existent grant_id", async () => {
    // Should not throw and should not affect any row.
    await repo.updateOnReconsent(
      "nonexistent_grant",
      {
        oauthRequestedScopes: ["files"],
        resource: null,
      },
      tx,
    );
    expect(await repo.findById("nonexistent_grant", tx)).toBeNull();
  });
});
