// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  asTestTx,
  cleanTestEnv,
  createTestEnv,
  createTestUser,
  disposeTestEnv,
  FINITE_TEST_LIMITS,
  type TestEnv,
} from "~/test/integration-helpers";
import type { AuthContext } from "../auth.server";
import { AuthorizationService } from "../authorization-service.server";
import { QuotaService } from "../quota-service.server";
import { hashToken } from "../token.server";
import { TokenRepository } from "../token-repository.server";
import { TokenService } from "../token-service.server";
import { UserRepository } from "../user-repository.server";

let tx: ReturnType<typeof asTestTx>;

let testEnv: TestEnv;
let service: TokenService;
let tokenRepo: TokenRepository;
const USER_ID = "user_token_svc_test";

beforeAll(async () => {
  testEnv = await createTestEnv();
  tx = asTestTx(testEnv.db);
});

afterAll(async () => {
  await disposeTestEnv(testEnv);
});

beforeEach(async () => {
  await cleanTestEnv(testEnv);
  await createTestUser(testEnv.db, {
    id: USER_ID,
    limits: { grant_limit: 100, revision_limit: 30 },
  });
  tokenRepo = new TokenRepository(testEnv.db);
  const userRepo = new UserRepository(testEnv.db);
  service = new TokenService(
    tokenRepo,
    testEnv.db,
    USER_ID,
    new AuthorizationService(),
    new QuotaService(userRepo, tokenRepo),
  );
});

/** Helper: user auth context */
function userAuth(userId = USER_ID): AuthContext {
  return { type: "user", user_id: userId };
}

/** Helper: token auth context */
function tokenAuth(opts: {
  tokenId: string;
  userId?: string;
  basePath?: string;
  canDelegate?: boolean;
  accessPaths?: Array<{
    path: string;
    access: "read" | "write";
  }>;
}): AuthContext {
  return {
    type: "token",
    token_id: opts.tokenId,
    user_id: opts.userId ?? USER_ID,
    base_path: opts.basePath ?? "/",
    can_delegate: opts.canDelegate ?? true,
    access_paths: opts.accessPaths ?? [{ path: "", access: "write" }],
    resource: null,
  };
}

// ---------------------------------------------------------------------------
// create — user auth
// ---------------------------------------------------------------------------

describe("create (user auth)", () => {
  it("creates token and returns access paths", async () => {
    const result = await service.create(userAuth(), {
      name: "My Token",
      base_path: "/docs",
      access_paths: [
        { path: "readme", access: "read" },
        { path: "src", access: "write" },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.token.name).toBe("My Token");
    expect(result.token.base_path).toBe("/docs");
    expect(result.token.can_delegate).toBe(false);
    expect(result.token.origin_id).toBeNull();
    expect(result.token.access_paths).toHaveLength(2);
    expect(result.token.access_paths[0]).toEqual({
      path: "readme",
      access: "read",
    });

    // Auto-issue: raw_token and expires_at should be present
    expect(result.raw_token).toMatch(/^s2_/);
    expect(result.expires_at).toBeDefined();

    // Verify token is usable (hash exists in DB)
    const hash = await hashToken(result.raw_token);
    const found = await tokenRepo.findByHash(hash);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(result.token.id);
  });

  it("accepts custom expires_in_days", async () => {
    const result = await service.create(userAuth(), {
      name: "Short Lived",
      expires_in_days: 7,
      access_paths: [{ path: "", access: "read" }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.raw_token).toMatch(/^s2_/);

    // Verify expiry is ~7 days from now
    const expires = new Date(result.expires_at).getTime();
    const expected = Date.now() + 7 * 86400_000;
    expect(Math.abs(expires - expected)).toBeLessThan(5000);
  });

  it("rejects expires_in_days > 365", async () => {
    const result = await service.create(userAuth(), {
      name: "Too Long",
      expires_in_days: 400,
      access_paths: [{ path: "", access: "read" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
  });

  it("auto-issued token shows has_token=true in list", async () => {
    await service.create(userAuth(), {
      name: "Listed",
      access_paths: [{ path: "", access: "read" }],
    });

    const list = await service.list(USER_ID);
    expect(list.tokens).toHaveLength(1);
    expect(list.tokens[0].has_active_secret).toBe(true);
    expect(list.tokens[0].token_expires_at).not.toBeNull();
  });

  it("defaults base_path to /", async () => {
    const result = await service.create(userAuth(), {
      name: "Default Base",
      access_paths: [{ path: "", access: "write" }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token.base_path).toBe("/");
  });

  it("rejects empty name", async () => {
    const result = await service.create(userAuth(), {
      name: "  ",
      access_paths: [{ path: "", access: "read" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
  });

  it("rejects base_path without leading /", async () => {
    const result = await service.create(userAuth(), {
      name: "Bad Path",
      base_path: "docs",
      access_paths: [{ path: "", access: "read" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
  });

  it("rejects base_path with ..", async () => {
    const result = await service.create(userAuth(), {
      name: "Traversal",
      base_path: "/docs/../etc",
      access_paths: [{ path: "", access: "read" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
  });

  it("rejects access_paths[].path with leading /", async () => {
    // access_paths are basePath-relative; leading "/" is reserved
    // for absolute base_path and is rejected as input on access_paths[].path.
    const result = await service.create(userAuth(), {
      name: "Bad Access Path",
      access_paths: [{ path: "/docs", access: "read" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
  });

  it("rejects access_paths[].path with ..", async () => {
    const result = await service.create(userAuth(), {
      name: "Traversal Access Path",
      access_paths: [{ path: "../etc", access: "read" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
  });

  it("canonicalizes trailing slash on access_paths[].path", async () => {
    const result = await service.create(userAuth(), {
      name: "Trailing Slash",
      access_paths: [{ path: "foo/", access: "read" }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token.access_paths).toEqual([
      { path: "foo", access: "read" },
    ]);
  });

  it("rejects empty access_paths array", async () => {
    // A token with zero access_paths authenticates but cannot access any
    // path (every WebDAV/file API returns 403); the server is the last line
    // of defense.
    const result = await service.create(userAuth(), {
      name: "No Paths",
      access_paths: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
    expect(result.message).toMatch(/at least one/i);
  });

  it("rejects duplicate access_paths after canonical normalization", async () => {
    const result = await service.create(userAuth(), {
      name: "Dup Paths",
      access_paths: [
        { path: "foo", access: "read" },
        { path: "foo/", access: "write" },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
  });
});

// ---------------------------------------------------------------------------
// create — token auth (delegation)
// ---------------------------------------------------------------------------

describe("create (token auth / delegation)", () => {
  it("creates child token via delegation", async () => {
    // Seed the parent in the DB so parent_grant_id FK is satisfied
    await tokenRepo.createToken(
      {
        id: "parent_tok",
        userId: USER_ID,
        name: "Parent",
        basePath: "/",
        canDelegate: true,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );
    const auth = tokenAuth({
      tokenId: "parent_tok",
      basePath: "/",
      canDelegate: true,
      accessPaths: [{ path: "", access: "write" }],
    });

    const result = await service.create(auth, {
      name: "Child Token",
      base_path: "/",
      access_paths: [{ path: "docs", access: "read" }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token.origin_id).toBe("parent_tok");
  });

  it("rejects when parent cannot delegate", async () => {
    // Seed the parent so the cross-user defense-in-depth check (which
    // verifies auth.token_id belongs to auth.user_id) doesn't fire first.
    await tokenRepo.createToken(
      {
        id: "no_delegate",
        userId: USER_ID,
        name: "No Delegate",
        basePath: "/",
        canDelegate: false,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );
    const auth = tokenAuth({
      tokenId: "no_delegate",
      canDelegate: false,
    });

    const result = await service.create(auth, {
      name: "Should Fail",
      access_paths: [{ path: "", access: "read" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("no_delegate_permission");
  });

  it("rejects child path outside parent scope", async () => {
    await tokenRepo.createToken(
      {
        id: "scoped_parent",
        userId: USER_ID,
        name: "Scoped Parent",
        basePath: "/docs",
        canDelegate: true,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );
    const auth = tokenAuth({
      tokenId: "scoped_parent",
      basePath: "/docs",
      canDelegate: true,
      accessPaths: [{ path: "readme", access: "write" }],
    });

    const result = await service.create(auth, {
      name: "Outside Scope",
      base_path: "/",
      access_paths: [{ path: "etc/passwd", access: "read" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("scope_violation");
  });

  it("rejects child granting more permissions than parent", async () => {
    await tokenRepo.createToken(
      {
        id: "readonly_parent",
        userId: USER_ID,
        name: "Readonly Parent",
        basePath: "/",
        canDelegate: true,
        originId: null,
        createdAt: new Date().toISOString(),
      },
      tx,
    );
    const auth = tokenAuth({
      tokenId: "readonly_parent",
      basePath: "/",
      canDelegate: true,
      accessPaths: [{ path: "", access: "read" }],
    });

    const result = await service.create(auth, {
      name: "Write Escalation",
      base_path: "/",
      access_paths: [{ path: "", access: "write" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("scope_violation");
  });
});

// ---------------------------------------------------------------------------
// create — access grant limit enforcement
// ---------------------------------------------------------------------------

describe("create (access grant limit)", () => {
  it("enforces configured grant limit", async () => {
    const freeUser = "user_free_limit";
    await createTestUser(testEnv.db, {
      id: freeUser,
      limits: FINITE_TEST_LIMITS,
    });

    const freeTokenRepo = new TokenRepository(testEnv.db);
    const freeUserRepo = new UserRepository(testEnv.db);
    const freeService = new TokenService(
      freeTokenRepo,
      testEnv.db,
      freeUser,
      new AuthorizationService(),
      new QuotaService(freeUserRepo, freeTokenRepo),
    );

    // Create tokens up to the limit (free = 5)
    for (let i = 0; i < 5; i++) {
      const r = await freeService.create(userAuth(freeUser), {
        name: `Token ${i}`,
        access_paths: [{ path: "", access: "read" }],
      });
      expect(r.ok).toBe(true);
    }

    // 6th should fail
    const result = await freeService.create(userAuth(freeUser), {
      name: "Over Limit",
      access_paths: [{ path: "", access: "read" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("limit_reached");
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("list", () => {
  it("returns empty list for user with no tokens", async () => {
    const result = await service.list(USER_ID);
    expect(result.tokens).toHaveLength(0);
    expect(result.grant_count).toBe(0);
  });

  it("aggregates flat JOIN rows into tokens with access paths", async () => {
    // Create two tokens with different access paths
    await service.create(userAuth(), {
      name: "Token A",
      base_path: "/",
      access_paths: [
        { path: "docs", access: "read" },
        { path: "src", access: "write" },
      ],
    });

    await service.create(userAuth(), {
      name: "Token B",
      base_path: "/projects",
      access_paths: [{ path: "app", access: "write" }],
    });

    const result = await service.list(USER_ID);
    expect(result.tokens).toHaveLength(2);
    expect(result.grant_count).toBe(2);

    const tokenA = result.tokens.find((t) => t.name === "Token A");
    expect(tokenA).toBeDefined();
    expect(tokenA?.access_paths).toHaveLength(2);

    const tokenB = result.tokens.find((t) => t.name === "Token B");
    expect(tokenB).toBeDefined();
    expect(tokenB?.access_paths).toHaveLength(1);
  });

  it("includes grant_limit from user limits", async () => {
    const result = await service.list(USER_ID);
    expect(result.grant_limit).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("update", () => {
  let tokenId: string;

  beforeEach(async () => {
    const r = await service.create(userAuth(), {
      name: "Before",
      base_path: "/old",
      access_paths: [{ path: "", access: "read" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    tokenId = r.token.id;
  });

  it("updates name", async () => {
    const result = await service.update(USER_ID, tokenId, { name: "After" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token.name).toBe("After");
  });

  it("updates base_path", async () => {
    const result = await service.update(USER_ID, tokenId, {
      base_path: "/new",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token.base_path).toBe("/new");
  });

  it("returns not_found for non-existent token", async () => {
    const result = await service.update(USER_ID, "nonexistent", {
      name: "X",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");
  });

  it("returns invalid_input when no fields provided", async () => {
    const result = await service.update(USER_ID, tokenId, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
  });

  it("rejects base_path with ..", async () => {
    const result = await service.update(USER_ID, tokenId, {
      base_path: "/a/../b",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("delete", () => {
  it("user auth deletes own token", async () => {
    const r = await service.create(userAuth(), {
      name: "Deletable",
      access_paths: [{ path: "", access: "read" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const result = await service.delete(userAuth(), r.token.id);
    expect(result.ok).toBe(true);

    // Verify deleted
    const list = await service.list(USER_ID);
    expect(list.tokens).toHaveLength(0);
  });

  it("returns not_found for non-existent token", async () => {
    const result = await service.delete(userAuth(), "nonexistent");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");
  });

  it("token auth deletes direct child (delegation)", async () => {
    // Create parent token
    const parent = await service.create(userAuth(), {
      name: "Parent",
      can_delegate: true,
      access_paths: [{ path: "", access: "write" }],
    });
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;

    // Create child via delegation
    const parentAuth = tokenAuth({
      tokenId: parent.token.id,
      canDelegate: true,
    });
    const child = await service.create(parentAuth, {
      name: "Child",
      access_paths: [{ path: "", access: "read" }],
    });
    expect(child.ok).toBe(true);
    if (!child.ok) return;

    // Parent deletes child
    const result = await service.delete(parentAuth, child.token.id);
    expect(result.ok).toBe(true);
  });

  it("token auth cannot delete non-child token (forbidden)", async () => {
    // Create two tokens via user auth
    const t1 = await service.create(userAuth(), {
      name: "Token1",
      access_paths: [{ path: "", access: "read" }],
    });
    expect(t1.ok).toBe(true);
    if (!t1.ok) return;

    const t2 = await service.create(userAuth(), {
      name: "Token2",
      access_paths: [{ path: "", access: "read" }],
    });
    expect(t2.ok).toBe(true);
    if (!t2.ok) return;

    // t1 tries to delete t2 (not its child)
    const auth = tokenAuth({ tokenId: t1.token.id });
    const result = await service.delete(auth, t2.token.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("forbidden");
  });

  it("token auth cannot delete grandchild", async () => {
    // Create parent
    const parent = await service.create(userAuth(), {
      name: "Grandparent",
      can_delegate: true,
      access_paths: [{ path: "", access: "write" }],
    });
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;

    // Create child via delegation
    const parentAuth = tokenAuth({
      tokenId: parent.token.id,
      canDelegate: true,
    });
    const child = await service.create(parentAuth, {
      name: "Child",
      can_delegate: true,
      access_paths: [{ path: "", access: "read" }],
    });
    expect(child.ok).toBe(true);
    if (!child.ok) return;

    // Create grandchild via child delegation
    const childAuth = tokenAuth({
      tokenId: child.token.id,
      canDelegate: true,
    });
    const grandchild = await service.create(childAuth, {
      name: "Grandchild",
      access_paths: [{ path: "", access: "read" }],
    });
    expect(grandchild.ok).toBe(true);
    if (!grandchild.ok) return;

    // Grandparent tries to delete grandchild — should fail
    const result = await service.delete(parentAuth, grandchild.token.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("forbidden");
  });

  it("user auth delete of parent with delegation child returns has_children", async () => {
    // Parent → child delegation chain (user_grants RESTRICT FK).
    const parent = await service.create(userAuth(), {
      name: "Parent",
      can_delegate: true,
      access_paths: [{ path: "", access: "write" }],
    });
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;

    const parentAuth = tokenAuth({
      tokenId: parent.token.id,
      canDelegate: true,
    });
    const child = await service.create(parentAuth, {
      name: "Child",
      access_paths: [{ path: "", access: "read" }],
    });
    expect(child.ok).toBe(true);
    if (!child.ok) return;

    // Attempt to delete the parent while the child still references it.
    const result = await service.delete(userAuth(), parent.token.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("has_children");

    // Both rows still present.
    const list = await service.list(USER_ID);
    const ids = list.tokens.map((t) => t.id).sort();
    expect(ids).toEqual([child.token.id, parent.token.id].sort());

    // After deleting the child first, parent delete succeeds.
    const childDel = await service.delete(userAuth(), child.token.id);
    expect(childDel.ok).toBe(true);
    const parentDel = await service.delete(userAuth(), parent.token.id);
    expect(parentDel.ok).toBe(true);
  });

  it("token auth delete of self with delegation child returns has_children", async () => {
    // Parent token deletes its own child's child? No — parent (user-auth)
    // creates a child token; that child then delegates to a grandchild. The
    // child token tries to delete itself via its own auth context — but the
    // child cannot delete itself via token auth (origin_id !== self), so use
    // the parent (user_grant) deleting the child via its delegation auth.
    const parent = await service.create(userAuth(), {
      name: "P",
      can_delegate: true,
      access_paths: [{ path: "", access: "write" }],
    });
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;

    const parentAuth = tokenAuth({
      tokenId: parent.token.id,
      canDelegate: true,
    });
    const child = await service.create(parentAuth, {
      name: "C",
      can_delegate: true,
      access_paths: [{ path: "", access: "read" }],
    });
    expect(child.ok).toBe(true);
    if (!child.ok) return;

    const childAuth = tokenAuth({
      tokenId: child.token.id,
      canDelegate: true,
    });
    const grandchild = await service.create(childAuth, {
      name: "GC",
      access_paths: [{ path: "", access: "read" }],
    });
    expect(grandchild.ok).toBe(true);
    if (!grandchild.ok) return;

    // Parent (token-auth) deletes child while grandchild still references it.
    const result = await service.delete(parentAuth, child.token.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("has_children");
  });
});

// ---------------------------------------------------------------------------
// issue / revoke cycle
// ---------------------------------------------------------------------------

describe("issue / rotate / revoke", () => {
  let tokenId: string;

  // `service.create` auto-issues a secret, so every test starts with an
  // already-issued token. Tests that need an unissued state call revoke first.
  beforeEach(async () => {
    const r = await service.create(userAuth(), {
      name: "Issuable",
      access_paths: [{ path: "", access: "write" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    tokenId = r.token.id;
  });

  // -- issue (first time) -------------------------------------------------

  it("issues a token with s2_ prefix and expires_at after revoke", async () => {
    await service.revoke(USER_ID, tokenId);
    const result = await service.issue(USER_ID, tokenId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.issued.token).toMatch(/^s2_/);
    expect(result.issued.expires_at).toBeTruthy();

    const hash = await hashToken(result.issued.token);
    const found = await tokenRepo.findByHash(hash);
    expect(found?.id).toBe(tokenId);
  });

  it("issue uses default 90-day expiry", async () => {
    await service.revoke(USER_ID, tokenId);
    const before = Date.now();
    const result = await service.issue(USER_ID, tokenId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expiresMs = new Date(result.issued.expires_at).getTime();
    const expectedMs = before + 90 * 86400_000;
    expect(Math.abs(expiresMs - expectedMs)).toBeLessThan(10_000);
  });

  it("issue respects custom expires_in_days", async () => {
    await service.revoke(USER_ID, tokenId);
    const result = await service.issue(USER_ID, tokenId, 7);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expiresMs = new Date(result.issued.expires_at).getTime();
    const expectedMs = Date.now() + 7 * 86400_000;
    expect(Math.abs(expiresMs - expectedMs)).toBeLessThan(10_000);
  });

  it("issue rejects expires_in_days > 365", async () => {
    await service.revoke(USER_ID, tokenId);
    const result = await service.issue(USER_ID, tokenId, 400);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
  });

  it("issue rejects negative expires_in_days", async () => {
    await service.revoke(USER_ID, tokenId);
    const result = await service.issue(USER_ID, tokenId, -1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
  });

  it("issue returns conflict when a secret is already active", async () => {
    const result = await service.issue(USER_ID, tokenId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("conflict");
  });

  it("issue returns not_found for non-existent token", async () => {
    const result = await service.issue(USER_ID, "nonexistent");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");
  });

  // -- rotate (replace existing) ------------------------------------------

  it("rotate replaces the existing secret", async () => {
    const result = await service.rotate(USER_ID, tokenId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issued.token).toMatch(/^s2_/);

    const hash = await hashToken(result.issued.token);
    const found = await tokenRepo.findByHash(hash);
    expect(found?.id).toBe(tokenId);
  });

  it("rotate returns conflict when no secret has been issued", async () => {
    await service.revoke(USER_ID, tokenId);
    const result = await service.rotate(USER_ID, tokenId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("conflict");
  });

  it("rotate returns not_found for non-existent token", async () => {
    const result = await service.rotate(USER_ID, "nonexistent");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");
  });

  // -- revoke -------------------------------------------------------------

  it("revoke clears the active secret", async () => {
    const hashBefore = await tokenRepo
      .listWithPathsByUser(USER_ID, tx)
      .then((rows) => rows.find((r) => r.id === tokenId));
    expect(hashBefore?.token_expires_at).not.toBeNull();

    const revokeResult = await service.revoke(USER_ID, tokenId);
    expect(revokeResult.ok).toBe(true);

    const hashAfter = await tokenRepo
      .listWithPathsByUser(USER_ID, tx)
      .then((rows) => rows.find((r) => r.id === tokenId));
    expect(hashAfter?.token_expires_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// replaceAccessPaths
// ---------------------------------------------------------------------------

describe("replaceAccessPaths", () => {
  let tokenId: string;

  beforeEach(async () => {
    const r = await service.create(userAuth(), {
      name: "AccessToken",
      base_path: "/",
      access_paths: [{ path: "old", access: "write" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    tokenId = r.token.id;
  });

  it("replaces access paths atomically", async () => {
    const result = await service.replaceAccessPaths(USER_ID, tokenId, [
      { path: "new/a", access: "read" },
      { path: "new/b", access: "write" },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.access_paths).toHaveLength(2);
    expect(result.access_paths).toEqual([
      { path: "new/a", access: "read" },
      { path: "new/b", access: "write" },
    ]);

    // Verify in DB
    const paths = await tokenRepo.getAccessPaths(tokenId, tx);
    expect(paths).toHaveLength(2);
  });

  it("returns not_found for non-existent token", async () => {
    const result = await service.replaceAccessPaths(USER_ID, "nonexistent", [
      { path: "", access: "read" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");
  });

  it("defaults to write when access field is omitted", async () => {
    const result = await service.replaceAccessPaths(USER_ID, tokenId, [
      { path: "minimal" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.access_paths).toEqual([{ path: "minimal", access: "write" }]);
  });

  it("rejects path with leading / (must be base-relative)", async () => {
    const result = await service.replaceAccessPaths(USER_ID, tokenId, [
      { path: "/docs", access: "read" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
  });

  it("rejects empty access_paths array", async () => {
    // Empty access_paths leaves the token with no scope; every subsequent
    // file/WebDAV request returns 403.
    const result = await service.replaceAccessPaths(USER_ID, tokenId, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
    expect(result.message).toMatch(/at least one/i);
  });

  it("rejects path containing ..", async () => {
    const result = await service.replaceAccessPaths(USER_ID, tokenId, [
      { path: "../etc", access: "read" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
  });

  it("canonicalizes trailing slash", async () => {
    const result = await service.replaceAccessPaths(USER_ID, tokenId, [
      { path: "foo/", access: "read" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.access_paths).toEqual([{ path: "foo", access: "read" }]);
  });

  it("rejects duplicate paths after canonical normalization", async () => {
    const result = await service.replaceAccessPaths(USER_ID, tokenId, [
      { path: "foo", access: "read" },
      { path: "foo/", access: "write" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_input");
  });
});

// ---------------------------------------------------------------------------
// cross-user isolation (service-level gate)
//
// TokenRepository's mutators (updateToken, writeSecret, revokeToken,
// deleteToken, replaceAccessPaths) take a tokenId only — they cannot enforce
// cross-user isolation themselves. The contract is that TokenService gates
// every mutation through an ownership check (getOwnedToken /
// getOwnedTokenDetail / getTokenOrigin) keyed on the caller's user_id, so a
// caller in user B's auth context can never mutate user A's grants. These
// tests pin that gate at the service level: build a real token owned by user
// A, then call each mutator from user B's auth context and assert that
// (a) the call rejects with not_found / forbidden, and (b) A's token is
// untouched.
// ---------------------------------------------------------------------------

describe("cross-user isolation", () => {
  const USER_A = "user_iso_a";
  const USER_B = "user_iso_b";
  let serviceA: TokenService;
  let serviceB: TokenService;
  let tokenA: string;
  let originalNameA: string;
  let originalBasePathA: string;
  let originalExpiresAtA: string | null;

  beforeEach(async () => {
    await createTestUser(testEnv.db, { id: USER_A });
    await createTestUser(testEnv.db, { id: USER_B });

    const userRepo = new UserRepository(testEnv.db);
    const quota = new QuotaService(userRepo, tokenRepo);
    const authz = new AuthorizationService();
    serviceA = new TokenService(tokenRepo, testEnv.db, USER_A, authz, quota);
    serviceB = new TokenService(tokenRepo, testEnv.db, USER_B, authz, quota);

    // Seed a token owned by A with a known shape so we can later assert
    // "no side effects" by reading it back.
    const created = await serviceA.create(userAuth(USER_A), {
      name: "A's Token",
      base_path: "/a-base",
      can_delegate: true,
      access_paths: [{ path: "a-orig", access: "write" }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("seed failed");
    tokenA = created.token.id;
    originalNameA = created.token.name;
    originalBasePathA = created.token.base_path;

    // Capture A's secret expires_at so we can prove writeSecret/revoke didn't
    // run. We reach into list() (same JOIN the API uses) for the value.
    // Normalize to ISO string — pg returns the column as a Date instance and
    // we want a stable comparand for later assertions.
    const list = await serviceA.list(USER_A);
    const row = list.tokens.find((t) => t.id === tokenA);
    originalExpiresAtA = row?.token_expires_at
      ? new Date(row.token_expires_at).toISOString()
      : null;
    expect(originalExpiresAtA).not.toBeNull();
  });

  // -- update -------------------------------------------------------------

  it("update from B against A's token rejects with not_found and leaves A's row untouched", async () => {
    const result = await serviceB.update(USER_B, tokenA, {
      name: "Hijacked",
      base_path: "/b-pwned",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");

    // Verify A's row is unchanged.
    const fromA = await serviceA.list(USER_A);
    const row = fromA.tokens.find((t) => t.id === tokenA);
    expect(row?.name).toBe(originalNameA);
    expect(row?.base_path).toBe(originalBasePathA);
  });

  // -- delete -------------------------------------------------------------

  it("delete from B (user auth) against A's token rejects with not_found and leaves A's row in place", async () => {
    const result = await serviceB.delete(userAuth(USER_B), tokenA);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");

    const fromA = await serviceA.list(USER_A);
    expect(fromA.tokens.some((t) => t.id === tokenA)).toBe(true);
  });

  it("delete from B (token auth) against A's token rejects and leaves A's row in place", async () => {
    // Seed a token owned by B so B has a valid token-auth context.
    const tokB = await serviceB.create(userAuth(USER_B), {
      name: "B's Token",
      can_delegate: true,
      access_paths: [{ path: "", access: "write" }],
    });
    expect(tokB.ok).toBe(true);
    if (!tokB.ok) return;

    const auth = tokenAuth({ tokenId: tokB.token.id, userId: USER_B });
    const result = await serviceB.delete(auth, tokenA);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // getTokenOrigin filters by user_id, so B's auth never sees A's row →
    // not_found (NOT forbidden, which would imply B's auth was scoped to A).
    expect(result.code).toBe("not_found");

    const fromA = await serviceA.list(USER_A);
    expect(fromA.tokens.some((t) => t.id === tokenA)).toBe(true);
  });

  // -- revoke -------------------------------------------------------------

  it("revoke from B against A's token rejects with not_found and leaves A's secret active", async () => {
    const result = await serviceB.revoke(USER_B, tokenA);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");

    const fromA = await serviceA.list(USER_A);
    const row = fromA.tokens.find((t) => t.id === tokenA);
    // Secret should still be active with the same expiry.
    expect(row?.has_active_secret).toBe(true);
    const after = row?.token_expires_at
      ? new Date(row.token_expires_at).toISOString()
      : null;
    expect(after).toBe(originalExpiresAtA);
  });

  // -- issue --------------------------------------------------------------

  it("issue from B against A's token rejects with not_found", async () => {
    // A's token already has a secret; revoke first to put it in the
    // "issuable" state so we know any error is from the cross-user gate
    // rather than the conflict guard.
    await serviceA.revoke(USER_A, tokenA);

    const result = await serviceB.issue(USER_B, tokenA);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");

    // Verify still unissued from A's side.
    const fromA = await serviceA.list(USER_A);
    const row = fromA.tokens.find((t) => t.id === tokenA);
    expect(row?.has_active_secret).toBe(false);
  });

  // -- rotate -------------------------------------------------------------

  it("rotate from B against A's token rejects with not_found and leaves A's secret untouched", async () => {
    const result = await serviceB.rotate(USER_B, tokenA);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");

    // A's secret expires_at should be unchanged (rotate would have moved it).
    const fromA = await serviceA.list(USER_A);
    const row = fromA.tokens.find((t) => t.id === tokenA);
    const after = row?.token_expires_at
      ? new Date(row.token_expires_at).toISOString()
      : null;
    expect(after).toBe(originalExpiresAtA);
  });

  // -- replaceAccessPaths -------------------------------------------------

  it("replaceAccessPaths from B against A's token rejects with not_found and leaves A's paths intact", async () => {
    const result = await serviceB.replaceAccessPaths(USER_B, tokenA, [
      { path: "b-injected", access: "write" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");

    // A's paths should be untouched.
    const paths = await tokenRepo.getAccessPaths(tokenA, tx);
    expect(paths).toHaveLength(1);
    expect(paths[0].path).toBe("a-orig");
    expect(paths[0].access).toBe("write");
  });

  // -- get ----------------------------------------------------------------

  it("get from B against A's token rejects with not_found", async () => {
    const result = await serviceB.get(USER_B, tokenA);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");
  });
});
