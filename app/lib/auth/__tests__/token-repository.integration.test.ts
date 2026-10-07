// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  asTestTx,
  cleanTestEnv,
  createTestEnv,
  createTestUser,
  disposeTestEnv,
  type TestEnv,
} from "~/test/integration-helpers";
import { TokenRepository } from "../token-repository.server";

let tx: ReturnType<typeof asTestTx>;

let testEnv: TestEnv;
let repo: TokenRepository;
const USER_ID = "user_token_repo_test";

beforeAll(async () => {
  testEnv = await createTestEnv();
  tx = asTestTx(testEnv.db);
});

afterAll(async () => {
  await disposeTestEnv(testEnv);
});

beforeEach(async () => {
  await cleanTestEnv(testEnv);
  await createTestUser(testEnv.db, { id: USER_ID });
  repo = new TokenRepository(testEnv.db);
});

// ---------------------------------------------------------------------------
// countByUser
// ---------------------------------------------------------------------------

describe("countByUser", () => {
  it("returns 0 when user has no tokens", async () => {
    const count = await repo.countByUser(USER_ID, tx);
    expect(count).toBe(0);
  });

  it("increments after creating tokens", async () => {
    await repo.createToken(
      {
        id: "tok_1",
        userId: USER_ID,
        name: "Token 1",
        basePath: "/",
        canDelegate: false,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );

    expect(await repo.countByUser(USER_ID, tx)).toBe(1);

    await repo.createToken(
      {
        id: "tok_2",
        userId: USER_ID,
        name: "Token 2",
        basePath: "/docs",
        canDelegate: false,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );

    expect(await repo.countByUser(USER_ID, tx)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// createToken + createAccessPaths
// ---------------------------------------------------------------------------

describe("createToken + createAccessPaths", () => {
  it("stores token and access paths", async () => {
    // First create the parent grant the child references via parent_grant_id FK
    const parentId = "tok_parent_for_create";
    await repo.createToken(
      {
        id: parentId,
        userId: USER_ID,
        name: "Parent",
        basePath: "/",
        canDelegate: true,
        originId: null,
        createdAt: "2026-01-01T00:00:00Z",
      },
      tx,
    );
    const tokenId = "tok_create";
    await repo.createToken(
      {
        id: tokenId,
        userId: USER_ID,
        name: "My Token",
        basePath: "/projects",
        canDelegate: true,
        originId: parentId,
        createdAt: "2026-01-01T00:00:00Z",
      },
      tx,
    );

    await repo.createAccessPaths(
      tokenId,
      [
        { path: "projects/a", access: "read" },
        { path: "projects/b", access: "write" },
      ],
      tx,
    );

    const paths = await repo.getAccessPaths(tokenId, tx);
    expect(paths).toHaveLength(2);
    expect(paths).toEqual(
      expect.arrayContaining([
        { path: "projects/a", access: "read" },
        { path: "projects/b", access: "write" },
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// getOwnedToken
// ---------------------------------------------------------------------------

describe("getOwnedToken", () => {
  it("returns token when found", async () => {
    await repo.createToken(
      {
        id: "tok_owned",
        userId: USER_ID,
        name: "Owned",
        basePath: "/",
        canDelegate: false,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );

    const row = await repo.getOwnedToken("tok_owned", USER_ID, tx);
    expect(row).toEqual({
      id: "tok_owned",
      name: "Owned",
      expires_at: null,
    });
  });

  it("returns null when token does not exist", async () => {
    const row = await repo.getOwnedToken("tok_missing", USER_ID, tx);
    expect(row).toBeNull();
  });

  it("returns null when user does not own the token", async () => {
    await repo.createToken(
      {
        id: "tok_other",
        userId: USER_ID,
        name: "Other",
        basePath: "/",
        canDelegate: false,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );

    const otherUser = "user_other_owner";
    await createTestUser(testEnv.db, { id: otherUser });

    const row = await repo.getOwnedToken("tok_other", otherUser, tx);
    expect(row).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getOwnedTokenDetail
// ---------------------------------------------------------------------------

describe("getOwnedTokenDetail", () => {
  it("returns id, name, and base_path", async () => {
    await repo.createToken(
      {
        id: "tok_detail",
        userId: USER_ID,
        name: "Detailed",
        basePath: "/data",
        canDelegate: false,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );

    const row = await repo.getOwnedTokenDetail("tok_detail", USER_ID, tx);
    expect(row).toEqual({
      id: "tok_detail",
      name: "Detailed",
      base_path: "/data",
    });
  });

  it("returns null for non-existent token", async () => {
    const row = await repo.getOwnedTokenDetail("tok_nope", USER_ID, tx);
    expect(row).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listWithPathsByUser
// ---------------------------------------------------------------------------

describe("listWithPathsByUser", () => {
  it("returns flat rows with access path join", async () => {
    const now = new Date().toISOString();
    await repo.createToken(
      {
        id: "tok_list",
        userId: USER_ID,
        name: "Listed",
        basePath: "/",
        canDelegate: true,
        originId: null,
        createdAt: now,
      },
      tx,
    );

    await repo.createAccessPaths(
      "tok_list",
      [
        { path: "a", access: "read" },
        { path: "b", access: "write" },
      ],
      tx,
    );

    const rows = await repo.listWithPathsByUser(USER_ID, tx);
    expect(rows).toHaveLength(2);

    // All rows share the same token fields
    for (const r of rows) {
      expect(r.id).toBe("tok_list");
      expect(r.name).toBe("Listed");
      expect(r.base_path).toBe("/");
      expect(r.token_can_delegate).toBe(true);
    }

    const paths = rows.map((r) => r.path).sort();
    expect(paths).toEqual(["a", "b"]);
  });

  it("returns a row with null path when token has no access paths", async () => {
    await repo.createToken(
      {
        id: "tok_nopaths",
        userId: USER_ID,
        name: "NoPaths",
        basePath: "/",
        canDelegate: false,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );

    const rows = await repo.listWithPathsByUser(USER_ID, tx);
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBeNull();
    expect(rows[0].access).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateToken
// ---------------------------------------------------------------------------

describe("updateToken", () => {
  const tokenId = "tok_update";

  beforeEach(async () => {
    await repo.createToken(
      {
        id: tokenId,
        userId: USER_ID,
        name: "Before",
        basePath: "/old",
        canDelegate: false,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );
  });

  it("updates name only", async () => {
    const updated = await repo.updateToken(tokenId, { name: "After" }, tx);
    expect(updated).toMatchObject({
      id: tokenId,
      name: "After",
      base_path: "/old",
      can_delegate: false,
    });
  });

  it("updates base_path only", async () => {
    const updated = await repo.updateToken(tokenId, { basePath: "/new" }, tx);
    expect(updated).toMatchObject({
      id: tokenId,
      name: "Before",
      base_path: "/new",
    });
  });

  it("updates multiple fields at once", async () => {
    const updated = await repo.updateToken(
      tokenId,
      {
        name: "Multi",
        basePath: "/multi",
        canDelegate: true,
      },
      tx,
    );
    expect(updated).toMatchObject({
      id: tokenId,
      name: "Multi",
      base_path: "/multi",
      can_delegate: true,
    });
  });

  it("returns null when no fields are provided", async () => {
    const result = await repo.updateToken(tokenId, {}, tx);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// writeSecret + findByHash
// ---------------------------------------------------------------------------

describe("writeSecret + findByHash", () => {
  it("issues a token and finds it by hash", async () => {
    const tokenId = "tok_issue";
    await repo.createToken(
      {
        id: tokenId,
        userId: USER_ID,
        name: "Issued",
        basePath: "/",
        canDelegate: true,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );

    const hash = "fakehash_abc123";
    const expiresAt = new Date(Date.now() + 86400000).toISOString(); // +1 day
    await repo.writeSecret(tokenId, hash, expiresAt, tx);

    const found = await repo.findByHash(hash);
    expect(found).toEqual({
      id: tokenId,
      user_id: USER_ID,
      base_path: "/",
      can_delegate: true,
      resource: null, // legacy api/webdav: not audience-bound
      access_paths: [],
    });
  });

  it("returns null for unknown hash", async () => {
    const found = await repo.findByHash("nonexistent_hash");
    expect(found).toBeNull();
  });

  it("returns null for expired token", async () => {
    const tokenId = "tok_expired";
    await repo.createToken(
      {
        id: tokenId,
        userId: USER_ID,
        name: "Expired",
        basePath: "/",
        canDelegate: false,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );

    const hash = "fakehash_expired";
    const expiredAt = new Date(Date.now() - 86400000).toISOString(); // -1 day
    await repo.writeSecret(tokenId, hash, expiredAt, tx);

    const found = await repo.findByHash(hash);
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// revokeToken + findByHash
// ---------------------------------------------------------------------------

describe("revokeToken + findByHash", () => {
  it("revoked token is no longer found by hash", async () => {
    const tokenId = "tok_revoke";
    await repo.createToken(
      {
        id: tokenId,
        userId: USER_ID,
        name: "Revokable",
        basePath: "/",
        canDelegate: false,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );

    const hash = "fakehash_revoke";
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    await repo.writeSecret(tokenId, hash, expiresAt, tx);

    // Verify token is findable before revocation
    expect(await repo.findByHash(hash)).not.toBeNull();

    await repo.revokeToken(tokenId, tx);

    // After revocation, hash lookup returns null
    expect(await repo.findByHash(hash)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// replaceAccessPaths
// ---------------------------------------------------------------------------

describe("replaceAccessPaths", () => {
  it("atomically replaces all access paths", async () => {
    const tokenId = "tok_replace";
    await repo.createToken(
      {
        id: tokenId,
        userId: USER_ID,
        name: "Replace",
        basePath: "/",
        canDelegate: false,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );

    // Create initial paths
    await repo.createAccessPaths(
      tokenId,
      [
        { path: "old/a", access: "write" },
        { path: "old/b", access: "read" },
      ],
      tx,
    );

    expect(await repo.getAccessPaths(tokenId, tx)).toHaveLength(2);

    // Replace with new paths
    await repo.replaceAccessPaths(
      tokenId,
      [{ path: "new/x", access: "write" }],
      tx,
    );

    const paths = await repo.getAccessPaths(tokenId, tx);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toEqual({
      path: "new/x",
      access: "write",
    });
  });
});

// ---------------------------------------------------------------------------
// deleteToken
// ---------------------------------------------------------------------------

describe("deleteToken", () => {
  it("cascade deletes access paths", async () => {
    const tokenId = "tok_delete";
    await repo.createToken(
      {
        id: tokenId,
        userId: USER_ID,
        name: "Deletable",
        basePath: "/",
        canDelegate: false,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );

    await repo.createAccessPaths(tokenId, [{ path: "x", access: "write" }], tx);

    await repo.deleteToken(tokenId, tx);

    // Token is gone
    expect(await repo.getOwnedToken(tokenId, USER_ID, tx)).toBeNull();

    // Access paths are gone (cascade)
    const paths = await repo.getAccessPaths(tokenId, tx);
    expect(paths).toHaveLength(0);

    // Count decremented
    expect(await repo.countByUser(USER_ID, tx)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-user isolation
//
// Pre-RLS guard tests: every function that takes user_id (or returns user_id)
// must reject access when the caller's user_id differs from the row owner.
// Pinning these expectations now means the upcoming Postgres RLS migration
// can flip the enforcement layer without semantic regressions, and any future
// "forgot the WHERE user_id" diff will fail loudly.
// ---------------------------------------------------------------------------

describe("cross-user isolation", () => {
  const USER_A = "user_xuser_a";
  const USER_B = "user_xuser_b";

  beforeEach(async () => {
    // USER_ID seeded by outer beforeEach is unused here; create the two
    // adversarial users explicitly so the intent is obvious.
    await createTestUser(testEnv.db, { id: USER_A });
    await createTestUser(testEnv.db, { id: USER_B });
  });

  // -- countByUser --------------------------------------------------------

  it("countByUser: A's tokens do not appear in B's count", async () => {
    await repo.createToken(
      {
        id: "tok_xa_1",
        userId: USER_A,
        name: "A1",
        basePath: "/",
        canDelegate: false,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );
    await repo.createToken(
      {
        id: "tok_xa_2",
        userId: USER_A,
        name: "A2",
        basePath: "/",
        canDelegate: false,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );

    expect(await repo.countByUser(USER_A, tx)).toBe(2);
    expect(await repo.countByUser(USER_B, tx)).toBe(0);
  });

  // -- listWithPathsByUser ------------------------------------------------

  it("listWithPathsByUser: B sees nothing of A's grants", async () => {
    await repo.createToken(
      {
        id: "tok_xa_list",
        userId: USER_A,
        name: "A's secret",
        basePath: "/private",
        canDelegate: false,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );
    await repo.createAccessPaths(
      "tok_xa_list",
      [{ path: "private/secret", access: "write" }],
      tx,
    );

    const aRows = await repo.listWithPathsByUser(USER_A, tx);
    expect(aRows).toHaveLength(1);
    expect(aRows[0].id).toBe("tok_xa_list");

    const bRows = await repo.listWithPathsByUser(USER_B, tx);
    expect(bRows).toHaveLength(0);
  });

  // -- getOwnedToken ------------------------------------------------------

  it("getOwnedToken: B passing A's grantId returns null", async () => {
    await repo.createToken(
      {
        id: "tok_xa_owned",
        userId: USER_A,
        name: "A owned",
        basePath: "/",
        canDelegate: false,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );

    expect(await repo.getOwnedToken("tok_xa_owned", USER_A, tx)).not.toBeNull();
    expect(await repo.getOwnedToken("tok_xa_owned", USER_B, tx)).toBeNull();
  });

  // -- getOwnedTokenDetail ------------------------------------------------

  it("getOwnedTokenDetail: B passing A's grantId returns null", async () => {
    await repo.createToken(
      {
        id: "tok_xa_detail",
        userId: USER_A,
        name: "A detail",
        basePath: "/data",
        canDelegate: false,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );

    expect(
      await repo.getOwnedTokenDetail("tok_xa_detail", USER_A, tx),
    ).not.toBeNull();
    expect(
      await repo.getOwnedTokenDetail("tok_xa_detail", USER_B, tx),
    ).toBeNull();
  });

  // -- getTokenOrigin -----------------------------------------------------

  it("getTokenOrigin: B passing A's grantId returns null", async () => {
    await repo.createToken(
      {
        id: "tok_xa_origin_parent",
        userId: USER_A,
        name: "Parent",
        basePath: "/",
        canDelegate: true,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );
    await repo.createToken(
      {
        id: "tok_xa_origin_child",
        userId: USER_A,
        name: "Child",
        basePath: "/",
        canDelegate: false,
        originId: "tok_xa_origin_parent",
        createdAt: new Date().toISOString(),
      },
      tx,
    );

    const aOwn = await repo.getTokenOrigin("tok_xa_origin_child", USER_A, tx);
    expect(aOwn).toEqual({
      id: "tok_xa_origin_child",
      origin_id: "tok_xa_origin_parent",
    });

    expect(
      await repo.getTokenOrigin("tok_xa_origin_child", USER_B, tx),
    ).toBeNull();
  });

  // -- createToken: stored row carries the caller's user_id ---------------

  it("createToken: stored token belongs to the supplied userId only", async () => {
    await repo.createToken(
      {
        id: "tok_xa_create",
        userId: USER_A,
        name: "A only",
        basePath: "/",
        canDelegate: false,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );

    // Direct ownership query confirms user_id binding
    expect(
      await repo.getOwnedToken("tok_xa_create", USER_A, tx),
    ).not.toBeNull();
    expect(await repo.getOwnedToken("tok_xa_create", USER_B, tx)).toBeNull();
  });

  // -- Delegation across users — blocked at schema level -------
  //
  // user_grants has a denormalized user_id column + composite FK
  // (parent_grant_id, user_id) → user_grants(grant_id, user_id). The schema
  // now refuses a delegation row whose parent belongs to a different user, so
  // the previous TokenService-only defense becomes belt + suspenders. This
  // test pins the new behavior; flipping it back to "accepted" must be a
  // deliberate migration with its own failing test.
  it("createToken: parent_grant_id pointing to another user's grant is rejected by the schema-level composite FK", async () => {
    await repo.createToken(
      {
        id: "tok_xa_parent",
        userId: USER_A,
        name: "A parent",
        basePath: "/",
        canDelegate: true,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );

    // B attempts to create a child pointing to A's user_grants row as parent.
    // The composite FK on (parent_grant_id, user_id) requires parent.user_id
    // to match the child's user_id, so this insert must fail.
    await expect(
      repo.createToken(
        {
          id: "tok_xb_child",
          userId: USER_B,
          name: "B child of A",
          basePath: "/",
          canDelegate: false,
          originId: "tok_xa_parent",
          createdAt: new Date().toISOString(),
        },
        tx,
      ),
    ).rejects.toThrow();

    // Neither user sees the would-be cross-user child.
    const bRows = await repo.listWithPathsByUser(USER_B, tx);
    expect(bRows.find((r) => r.id === "tok_xb_child")).toBeUndefined();
    const aRows = await repo.listWithPathsByUser(USER_A, tx);
    expect(aRows.find((r) => r.id === "tok_xb_child")).toBeUndefined();
  });

  // -- findByHash returns the row's actual user_id ------------------------

  it("findByHash: returned user_id is the row owner regardless of who calls", async () => {
    await repo.createToken(
      {
        id: "tok_xa_hash",
        userId: USER_A,
        name: "A hash",
        basePath: "/",
        canDelegate: false,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );
    const hash = "fakehash_xa";
    await repo.writeSecret(
      "tok_xa_hash",
      hash,
      new Date(Date.now() + 86400000).toISOString(),
      tx,
    );

    // findByHash takes no user arg — it returns the row owner.
    // The contract here is "the caller must compare returned user_id to its
    // own auth context". This test pins that contract by asserting the row
    // never claims user B even when the lookup is initiated in B's context.
    const found = await repo.findByHash(hash);
    expect(found?.user_id).toBe(USER_A);
    expect(found?.user_id).not.toBe(USER_B);
  });
});
