// @ts-nocheck
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  bearerHeader,
  cleanTestEnv,
  createTestEnv,
  createTestUser,
  disposeTestEnv,
  FINITE_TEST_LIMITS,
  issueTestToken,
  type TestEnv,
  testLoadContext,
} from "~/test/integration-helpers";
import { action } from "../api.tokens";
import { action as deleteAction } from "../api.tokens.$id";

let testEnv: TestEnv;
let token: string;
const USER_ID = "user_tokens_test";

function ctx() {
  return testLoadContext(testEnv);
}

function post(rawToken: string, body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/v1/tokens", {
    method: "POST",
    headers: {
      Authorization: bearerHeader(rawToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  testEnv = await createTestEnv();
});

afterAll(async () => {
  await disposeTestEnv(testEnv);
});

beforeEach(async () => {
  await cleanTestEnv(testEnv);

  const user = await createTestUser(testEnv.db, {
    id: USER_ID,
  });
  const tok = await issueTestToken(testEnv.db, {
    userId: user.id,
    canDelegate: true,
  });
  token = tok.rawToken;
});

// ── Basic creation ──────────────────────────────────────────

describe("token creation", () => {
  it("creates a token with delegation and returns 201", async () => {
    const res = await action({
      request: post(token, {
        name: "My Token",
        base_path: "/",
        access_paths: [{ path: "", access: "write" }],
      }),
      context: ctx(),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token.name).toBe("My Token");
    expect(body.token.origin_id).toBeDefined();
    // Auto-issue: raw_token and expires_at in response
    expect(body.raw_token).toMatch(/^s2_/);
    expect(body.expires_at).toBeDefined();
  });

  it("returns 401 without auth", async () => {
    const r = new Request("http://localhost/api/v1/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test", access_paths: [] }),
    });
    const res = await action({ request: r, context: ctx() });
    expect(res.status).toBe(401);
  });

  it("returns 405 for non-POST", async () => {
    const r = new Request("http://localhost/api/v1/tokens", {
      method: "GET",
      headers: { Authorization: bearerHeader(token) },
    });
    const res = await action({ request: r, context: ctx() });
    expect(res.status).toBe(405);
  });
});

// ── Validation ──────────────────────────────────────────────

describe("validation", () => {
  it("rejects missing name", async () => {
    const res = await action({
      request: post(token, {
        access_paths: [{ path: "", access: "read" }],
      }),
      context: ctx(),
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid base_path", async () => {
    const res = await action({
      request: post(token, {
        name: "bad",
        base_path: "no-slash",
        access_paths: [{ path: "", access: "read" }],
      }),
      context: ctx(),
    });
    expect(res.status).toBe(400);
  });

  it("rejects base_path with ..", async () => {
    const res = await action({
      request: post(token, {
        name: "bad",
        base_path: "/../etc",
        access_paths: [{ path: "", access: "read" }],
      }),
      context: ctx(),
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-array access_paths", async () => {
    const res = await action({
      request: post(token, {
        name: "bad",
        access_paths: "not-array",
      }),
      context: ctx(),
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON", async () => {
    const r = new Request("http://localhost/api/v1/tokens", {
      method: "POST",
      headers: {
        Authorization: bearerHeader(token),
        "Content-Type": "application/json",
      },
      body: "not json",
    });
    const res = await action({ request: r, context: ctx() });
    expect(res.status).toBe(400);
  });
});

// ── Delegation scope ────────────────────────────────────────

describe("delegation scope", () => {
  it("rejects delegation when parent lacks can_delegate", async () => {
    const noDelegateUser = await createTestUser(testEnv.db, {
      id: "user_nodeleg",
    });
    const noDelegateTok = await issueTestToken(testEnv.db, {
      userId: noDelegateUser.id,
      canDelegate: false,
    });

    const res = await action({
      request: post(noDelegateTok.rawToken, {
        name: "child",
        access_paths: [{ path: "", access: "read" }],
      }),
      context: ctx(),
    });
    expect(res.status).toBe(403);
  });

  it("allows child within parent scope", async () => {
    // Parent has "/" access. Child base_path="/docs", access="/notes"
    // resolvePath("/docs", "/notes") = "/docs/notes" which is under "/"
    const res = await action({
      request: post(token, {
        name: "scoped-child",
        base_path: "/docs",
        access_paths: [{ path: "notes", access: "read" }],
      }),
      context: ctx(),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token.base_path).toBe("/docs");
  });

  it("rejects child outside parent scope", async () => {
    // Create a parent token scoped to /docs only
    const scopedUser = await createTestUser(testEnv.db, {
      id: "user_scoped",
    });
    const scopedTok = await issueTestToken(testEnv.db, {
      userId: scopedUser.id,
      canDelegate: true,
      paths: [{ path: "docs", access: "write" }],
    });

    // Try to create child with access to /secret (outside /docs scope)
    const res = await action({
      request: post(scopedTok.rawToken, {
        name: "escape-child",
        base_path: "/",
        access_paths: [{ path: "secret", access: "read" }],
      }),
      context: ctx(),
    });
    expect(res.status).toBe(403);
  });

  it("rejects child write escalation under read-only parent path", async () => {
    const roUser = await createTestUser(testEnv.db, {
      id: "user_ro_deleg",
    });
    const roTok = await issueTestToken(testEnv.db, {
      userId: roUser.id,
      canDelegate: true,
      paths: [{ path: "docs", access: "read" }],
    });

    const res = await action({
      request: post(roTok.rawToken, {
        name: "escalate-write",
        base_path: "/",
        access_paths: [{ path: "docs", access: "write" }],
      }),
      context: ctx(),
    });
    expect(res.status).toBe(403);
  });

  it("allows child permission downgrade within same path", async () => {
    // Parent has rw on / — child requests read-only on /docs
    const res = await action({
      request: post(token, {
        name: "downgrade",
        base_path: "/",
        access_paths: [{ path: "docs", access: "read" }],
      }),
      context: ctx(),
    });
    expect(res.status).toBe(201);
  });

  it("uses most specific parent rule for overlapping permissions", async () => {
    // Parent has: read-only on /, read+write on /docs
    // Child requests write on /docs → should succeed (specific rule wins)
    const overlapUser = await createTestUser(testEnv.db, {
      id: "user_overlap",
    });
    const overlapTok = await issueTestToken(testEnv.db, {
      userId: overlapUser.id,
      canDelegate: true,
      paths: [
        { path: "", access: "read" },
        { path: "docs", access: "write" },
      ],
    });

    const res = await action({
      request: post(overlapTok.rawToken, {
        name: "overlap-child",
        base_path: "/",
        access_paths: [{ path: "docs", access: "write" }],
      }),
      context: ctx(),
    });
    expect(res.status).toBe(201);
  });
});

// ── grant_paths only ─────────────────

describe("grant_paths population", () => {
  it("inserts access path when access_path is root (empty)", async () => {
    const res = await action({
      request: post(token, {
        name: "root-token",
        base_path: "/",
        access_paths: [{ path: "", access: "write" }],
      }),
      context: ctx(),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const tokenId = body.token.id;

    const paths = await testEnv.db.query<{
      path: string;
      access: string;
    }>("SELECT path, access FROM grant_paths WHERE grant_id = $1", [tokenId]);
    expect(paths).toHaveLength(1);
    expect(paths[0].path).toBe("");
    expect(paths[0].access).toBe("write");
  });

  it("stores non-existent sub-path without error", async () => {
    // /photos/ doesn't exist yet — path-based system stores it anyway
    const res = await action({
      request: post(token, {
        name: "subpath-token",
        base_path: "/",
        access_paths: [{ path: "photos/", access: "read" }],
      }),
      context: ctx(),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const tokenId = body.token.id;

    const paths = await testEnv.db.query(
      "SELECT * FROM grant_paths WHERE grant_id = $1",
      [tokenId],
    );
    expect(paths).toHaveLength(1); // stored even though /photos/ doesn't exist
  });
});

// ── Plan limits ─────────────────────────────────────────────

describe("token limits", () => {
  it("enforces a 5-token limit", async () => {
    const freeUser = await createTestUser(testEnv.db, {
      id: "user_free_tok",
      limits: FINITE_TEST_LIMITS,
    });
    const freeTok = await issueTestToken(testEnv.db, {
      userId: freeUser.id,
      canDelegate: true,
    });

    // Create 4 more tokens (already have 1 from issueTestToken)
    for (let i = 0; i < 4; i++) {
      await issueTestToken(testEnv.db, {
        userId: freeUser.id,
        name: `extra-${i}`,
      });
    }

    // 6th token should fail
    const res = await action({
      request: post(freeTok.rawToken, {
        name: "too-many",
        access_paths: [{ path: "", access: "read" }],
      }),
      context: ctx(),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toContain("limit");
  });
});

// ── DELETE /api/v1/tokens/:id (Bearer can revoke direct children) ──

function del(rawToken: string, tokenId: string): [Request, unknown] {
  return [
    new Request(`http://localhost/api/v1/tokens/${tokenId}`, {
      method: "DELETE",
      headers: { Authorization: bearerHeader(rawToken) },
    }),
    ctx(),
  ];
}

describe("DELETE /api/v1/tokens/:id", () => {
  it("parent deletes direct child and returns 204", async () => {
    // Create child via delegation
    const createRes = await action({
      request: post(token, {
        name: "child-to-delete",
        access_paths: [{ path: "", access: "read" }],
      }),
      context: ctx(),
    });
    expect(createRes.status).toBe(201);
    const { token: child } = await createRes.json();

    const [req, context] = del(token, child.id);
    const res = await deleteAction({
      request: req,
      context,
      params: { id: child.id },
    });
    expect(res.status).toBe(204);
  });

  it("returns 401 without auth", async () => {
    const req = new Request("http://localhost/api/v1/tokens/fake-id", {
      method: "DELETE",
    });
    const res = await deleteAction({
      request: req,
      context: ctx(),
      params: { id: "fake-id" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 when deleting non-child token", async () => {
    // Create a sibling token (not a child of the test token)
    const sibling = await issueTestToken(testEnv.db, {
      userId: USER_ID,
      name: "sibling",
    });

    const [req, context] = del(token, sibling.id);
    const res = await deleteAction({
      request: req,
      context,
      params: { id: sibling.id },
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 for non-existent token", async () => {
    const [req, context] = del(token, "nonexistent");
    const res = await deleteAction({
      request: req,
      context,
      params: { id: "nonexistent" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 has_children when deleting parent with delegation child", async () => {
    // The Bearer-auth path can only delete its own direct child, so we set up
    // grandparent → parent → child and have the parent token try to delete
    // its own child while the grandchild still references it. The route maps
    // the FK violation (ON DELETE RESTRICT) to 409 has_children.
    // Build via two delegation creations through the API.
    const parentRes = await action({
      request: post(token, {
        name: "parent",
        can_delegate: true,
        access_paths: [{ path: "", access: "write" }],
      }),
      context: ctx(),
    });
    expect(parentRes.status).toBe(201);
    const { raw_token: parentRaw } = await parentRes.json();

    const childRes = await action({
      request: post(parentRaw, {
        name: "child",
        can_delegate: true,
        access_paths: [{ path: "", access: "read" }],
      }),
      context: ctx(),
    });
    expect(childRes.status).toBe(201);
    const { token: childTok, raw_token: childRaw } = await childRes.json();

    // grandchild via child's auth so it references child as parent_grant_id.
    const gcRes = await action({
      request: post(childRaw, {
        name: "gc",
        access_paths: [{ path: "", access: "read" }],
      }),
      context: ctx(),
    });
    expect(gcRes.status).toBe(201);

    // parent (Bearer) deletes child while grandchild still hangs off child →
    // RESTRICT → 409.
    const [req, context] = del(parentRaw, childTok.id);
    const res = await deleteAction({
      request: req,
      context,
      params: { id: childTok.id },
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("has_children");
  });

  it("returns 405 for non-DELETE methods (PATCH lives at /internal/tokens/:id)", async () => {
    const req = new Request("http://localhost/api/v1/tokens/some-id", {
      method: "PATCH",
      headers: { Authorization: bearerHeader(token) },
    });
    const res = await deleteAction({
      request: req,
      context: ctx(),
      params: { id: "some-id" },
    });
    expect(res.status).toBe(405);
  });
});
