// @vitest-environment node
//
// RefreshTokenRepository integration tests — focus on cross-user isolation
// (pre-RLS guard).
//
// refresh_tokens is intentionally NOT under RLS because the
// security boundary is `token_hash` (UNIQUE in the schema). These tests
// pin the contract:
//
//   1. CRUD basics: insert / findByHash / consume / revokeAllForGrant
//   2. token_hash uniqueness across users (no collision = no leak)
//   3. consume() / revokeAllForGrant() are scoped narrowly enough that
//      A's tokens don't get touched when operating on B's
//   4. findByHash returns the row's actual grant_id; caller must compare
//      the resolved user_id (via oauth_grants) to its auth context
//
// findByHash / consume / revokeAllForGrant do NOT take a user_id arg by
// design — but the cross-user expectation is that B can never *reach* A's
// row using B-side identifiers (B's hash, B's grant_id).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "~/lib/auth/token.server";
import {
  asTestTx,
  cleanTestEnv,
  createTestEnv,
  createTestUser,
  disposeTestEnv,
  type TestEnv,
} from "~/test/integration-helpers";
import { OAuthGrantRepository } from "../oauth-grant-repository.server";
import { RefreshTokenRepository } from "../refresh-token-repository.server";

let tx: ReturnType<typeof asTestTx>;

let testEnv: TestEnv;
let repo: RefreshTokenRepository;
let grantRepo: OAuthGrantRepository;

const USER_A = "user_refresh_a";
const USER_B = "user_refresh_b";
const CLIENT_X = "refresh_client_x";
const CLIENT_Y = "refresh_client_y";

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

  await testEnv.db.execute(
    `INSERT INTO oauth_clients (id, client_name, redirect_uris, token_endpoint_auth_method)
     VALUES ($1, 'Refresh Client X', ARRAY['http://127.0.0.1/cb'], 'none'),
            ($2, 'Refresh Client Y', ARRAY['http://127.0.0.1/cb'], 'none')`,
    [CLIENT_X, CLIENT_Y],
  );

  repo = new RefreshTokenRepository(testEnv.db);
  grantRepo = new OAuthGrantRepository();
});

// Helper: seed an oauth grant + a refresh token row for that grant.
async function seedRefresh(opts: {
  grantId: string;
  userId: string;
  refreshId: string;
  rawToken: string;
  expiresAt?: string;
  clientId?: string;
}): Promise<{ hash: string }> {
  await grantRepo.create(
    {
      grantId: opts.grantId,
      userId: opts.userId,
      basePath: "/",
      createdAt: new Date().toISOString(),
      oauthClientId: opts.clientId ?? CLIENT_X,
      oauthRequestedScopes: ["files"],
      resource: null,
    },
    tx,
  );
  const hash = await hashToken(opts.rawToken);
  await repo.insert(
    {
      id: opts.refreshId,
      grantId: opts.grantId,
      tokenHash: hash,
      expiresAt:
        opts.expiresAt ?? new Date(Date.now() + 86400_000).toISOString(),
    },
    tx,
  );
  return { hash };
}

// ---------------------------------------------------------------------------
// insert + findByHash
// ---------------------------------------------------------------------------

describe("insert + findByHash", () => {
  it("round-trips an active refresh token", async () => {
    const { hash } = await seedRefresh({
      grantId: "grant_rt_1",
      userId: USER_A,
      refreshId: "rt_1",
      rawToken: "raw_rt_1",
    });

    const row = await repo.findByHash(hash);
    expect(row?.id).toBe("rt_1");
    expect(row?.grant_id).toBe("grant_rt_1");
    expect(row?.used_at).toBeNull();
    expect(row?.revoked_at).toBeNull();
    expect(row?.revocation_reason).toBeNull();
  });

  it("returns null for unknown hash", async () => {
    const row = await repo.findByHash("does_not_exist");
    expect(row).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// consume
// ---------------------------------------------------------------------------

describe("consume", () => {
  it("marks the refresh token as used and returns the row", async () => {
    await seedRefresh({
      grantId: "grant_rt_consume",
      userId: USER_A,
      refreshId: "rt_consume",
      rawToken: "raw_consume",
    });

    const consumed = await repo.consume("rt_consume", tx);
    expect(consumed).not.toBeNull();
    expect(consumed?.id).toBe("rt_consume");
    expect(consumed?.used_at).not.toBeNull();
  });

  it("returns null for an already-used token (reuse detection)", async () => {
    await seedRefresh({
      grantId: "grant_rt_reuse",
      userId: USER_A,
      refreshId: "rt_reuse",
      rawToken: "raw_reuse",
    });

    expect(await repo.consume("rt_reuse", tx)).not.toBeNull();
    expect(await repo.consume("rt_reuse", tx)).toBeNull();
  });

  it("returns null for a revoked token", async () => {
    await seedRefresh({
      grantId: "grant_rt_rev",
      userId: USER_A,
      refreshId: "rt_rev",
      rawToken: "raw_rev",
    });
    await repo.revokeAllForGrant("grant_rt_rev", "reconsent", tx);

    expect(await repo.consume("rt_rev", tx)).toBeNull();
  });

  it("returns null for an expired token", async () => {
    await seedRefresh({
      grantId: "grant_rt_exp",
      userId: USER_A,
      refreshId: "rt_exp",
      rawToken: "raw_exp",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });

    expect(await repo.consume("rt_exp", tx)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// revokeAllForGrant
// ---------------------------------------------------------------------------

describe("revokeAllForGrant", () => {
  it("revokes only refresh tokens of the targeted grant", async () => {
    await seedRefresh({
      grantId: "grant_rev_1",
      userId: USER_A,
      refreshId: "rt_rev_a1",
      rawToken: "raw_rev_a1",
    });
    // Second active refresh on the same grant — partial UNIQUE in the
    // schema technically forbids two actives, but we already have one;
    // seed a *different* grant for variety.
    await seedRefresh({
      grantId: "grant_rev_2",
      userId: USER_A,
      refreshId: "rt_rev_a2",
      rawToken: "raw_rev_a2",
      clientId: CLIENT_Y, // distinct (user, client) pair
    });

    await repo.revokeAllForGrant("grant_rev_1", "reconsent", tx);

    const r1 = await repo.findByHash(await hashToken("raw_rev_a1"));
    const r2 = await repo.findByHash(await hashToken("raw_rev_a2"));

    expect(r1?.revoked_at).not.toBeNull();
    expect(r1?.revocation_reason).toBe("reconsent");
    // Other grant untouched
    expect(r2?.revoked_at).toBeNull();
    expect(r2?.revocation_reason).toBeNull();
  });

  it("does not touch already-used tokens (reuse detection invariant)", async () => {
    await seedRefresh({
      grantId: "grant_rev_used",
      userId: USER_A,
      refreshId: "rt_used",
      rawToken: "raw_used",
    });
    await repo.consume("rt_used", tx);

    await repo.revokeAllForGrant("grant_rev_used", "reconsent", tx);

    const row = await repo.findByHash(await hashToken("raw_used"));
    // used_at set, revoked_at remains null — preserves "I just re-consented"
    // path (RFC 9700 §4.14: don't trip reuse detection on legitimate
    // re-consent of already-rotated tokens).
    expect(row?.used_at).not.toBeNull();
    expect(row?.revoked_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cross-user isolation
// ---------------------------------------------------------------------------

describe("cross-user isolation", () => {
  it("findByHash: B's hash never resolves to A's row", async () => {
    await seedRefresh({
      grantId: "grant_xu_a",
      userId: USER_A,
      refreshId: "rt_xu_a",
      rawToken: "raw_xu_a",
    });
    await seedRefresh({
      grantId: "grant_xu_b",
      userId: USER_B,
      refreshId: "rt_xu_b",
      rawToken: "raw_xu_b",
    });

    const aHash = await hashToken("raw_xu_a");
    const bHash = await hashToken("raw_xu_b");

    // Each hash resolves to its own grant — no crossover.
    const aRow = await repo.findByHash(aHash);
    const bRow = await repo.findByHash(bHash);

    expect(aRow?.grant_id).toBe("grant_xu_a");
    expect(bRow?.grant_id).toBe("grant_xu_b");

    // The grant_id resolved by findByHash maps back to the correct user
    // via oauth_grants — the caller MUST cross-check this before acting.
    const aGrant = await grantRepo.findById(aRow?.grant_id ?? "", tx);
    const bGrant = await grantRepo.findById(bRow?.grant_id ?? "", tx);
    expect(aGrant?.user_id).toBe(USER_A);
    expect(bGrant?.user_id).toBe(USER_B);
  });

  it("consume: takes no actor — caller (OAuthService) must verify ownership upstream via refresh-token plaintext", async () => {
    // Documented schema gap: consume(id) does not know about users. The
    // OAuth service path always reaches this method with an `id` that came
    // from findByHash on a presented refresh token, so an attacker would
    // need A's plaintext refresh token to know A's `rt_id`. This test
    // pins the gap so any hardening (e.g. composite WHERE id = $1 AND
    // grant_id IN (SELECT ... FROM oauth_grants WHERE user_id = $2)) is a
    // deliberate change with its own test.
    await seedRefresh({
      grantId: "grant_xu_consume_a",
      userId: USER_A,
      refreshId: "rt_xu_consume_a",
      rawToken: "raw_xu_consume_a",
    });

    // B "knows" A's refresh_id (hypothetical leak) — repo lets it consume.
    // This is the documented current behavior; the security boundary lives
    // upstream (refresh_token plaintext is the secret).
    const consumed = await repo.consume("rt_xu_consume_a", tx);
    expect(consumed?.id).toBe("rt_xu_consume_a");
    expect(consumed?.grant_id).toBe("grant_xu_consume_a");

    // The grant_id resolves back to A — caller must compare to its auth
    // context to detect a cross-user attempt.
    const grant = await grantRepo.findById(consumed?.grant_id ?? "", tx);
    expect(grant?.user_id).toBe(USER_A);
  });

  it("revokeAllForGrant: takes no actor — caller (OAuthService) must verify grant ownership upstream", async () => {
    // Same caller-responsibility contract as consume(). The OAuth service
    // path reaches revokeAllForGrant only after ownership has been verified
    // by upstream code (e.g. via session user_id + oauth_grants lookup).
    await seedRefresh({
      grantId: "grant_xu_rev_a",
      userId: USER_A,
      refreshId: "rt_xu_rev_a",
      rawToken: "raw_xu_rev_a",
    });
    await seedRefresh({
      grantId: "grant_xu_rev_b",
      userId: USER_B,
      refreshId: "rt_xu_rev_b",
      rawToken: "raw_xu_rev_b",
    });

    // B revokes A's grant — repo accepts it.
    await repo.revokeAllForGrant("grant_xu_rev_a", "reconsent", tx);

    const aRow = await repo.findByHash(await hashToken("raw_xu_rev_a"));
    const bRow = await repo.findByHash(await hashToken("raw_xu_rev_b"));

    // A's token is revoked; B's untouched. The repo did exactly what it
    // was told — the user_id check belongs upstream.
    expect(aRow?.revoked_at).not.toBeNull();
    expect(bRow?.revoked_at).toBeNull();
  });

  it("token_hash uniqueness: same plaintext across users would collide (UNIQUE constraint enforces)", async () => {
    // Schema-level guarantee: refresh_tokens.token_hash is UNIQUE. Two
    // users cannot end up with the same hash (collision astronomically
    // unlikely with cryptographic hashing of generated tokens, but the
    // UNIQUE makes it impossible at the DB layer). Verify via attempted
    // duplicate insert.
    const { hash } = await seedRefresh({
      grantId: "grant_xu_uniq_a",
      userId: USER_A,
      refreshId: "rt_xu_uniq_a",
      rawToken: "raw_xu_uniq",
    });

    // Seed a B grant so the second insert would otherwise succeed.
    await grantRepo.create(
      {
        grantId: "grant_xu_uniq_b",
        userId: USER_B,
        basePath: "/",
        createdAt: new Date().toISOString(),
        oauthClientId: CLIENT_X,
        oauthRequestedScopes: ["files"],
        resource: null,
      },
      tx,
    );

    await expect(
      repo.insert(
        {
          id: "rt_xu_uniq_b",
          grantId: "grant_xu_uniq_b",
          tokenHash: hash, // same hash as A's row
          expiresAt: new Date(Date.now() + 86400_000).toISOString(),
        },
        tx,
      ),
    ).rejects.toThrow();
  });
});
