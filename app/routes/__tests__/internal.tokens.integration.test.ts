// @ts-nocheck
// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanTestEnv,
  createTestEnv,
  createTestUser,
  createUnissuedTestToken,
  disposeTestEnv,
  issueTestToken,
  sessionCookieHeader,
  type TestEnv,
  testLoadContext,
} from "~/test/integration-helpers";
import { action as deleteAction } from "../api.tokens.$id";
import { loader } from "../internal.tokens";
import { action as patchAction } from "../internal.tokens.$id";
import { action as accessPathsAction } from "../internal.tokens.$id.access-paths";
import { action as issueAction } from "../internal.tokens.$id.issue";
import { action as rotateAction } from "../internal.tokens.$id.rotate";
import { action as secretAction } from "../internal.tokens.$id.secret";

let testEnv: TestEnv;
let cookie: string;
let tokenId: string;
const USER_ID = "user_session_tok";

function ctx() {
  return testLoadContext(testEnv);
}

function cookieHeaders(): Headers {
  const h = new Headers();
  h.set("Cookie", cookie);
  return h;
}

function sessionReq(method: string, url: string, body?: unknown): Request {
  const h = cookieHeaders();
  if (body !== undefined) {
    h.set("Content-Type", "application/json");
  }
  return new Request(url, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
    limits: { grant_limit: 100 },
  });
  cookie = await sessionCookieHeader(user.id, testEnv.env);
  const tok = await issueTestToken(testEnv.db, {
    userId: user.id,
    name: "Default",
    canDelegate: true,
  });
  tokenId = tok.id;
});

// ── GET /internal/tokens ─────────────────────────────────

describe("list tokens", () => {
  it("returns tokens with access_paths, count, and limit", async () => {
    const res = await loader({
      request: new Request("http://localhost/internal/tokens", {
        headers: cookieHeaders(),
      }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0].name).toBe("Default");
    expect(body.tokens[0].access_paths).toHaveLength(1);
    expect(body.grant_count).toBe(1);
    expect(body.grant_limit).toBe(100);
  });

  it("returns 401 without auth", async () => {
    const res = await loader({
      request: new Request("http://localhost/internal/tokens"),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(401);
  });

  // Bearer rejection on /internal/* is enforced by app/lib/gateway/middleware.ts middleware
  // (covered by app/lib/gateway/middleware.test.ts), not by the handler. Integration
  // tests bypass middleware so we don't re-test that here.
});

// ── PATCH /internal/tokens/:id ───────────────────────────

describe("PATCH token", () => {
  it("updates name and base_path", async () => {
    const res = await patchAction({
      request: sessionReq(
        "PATCH",
        `http://localhost/internal/tokens/${tokenId}`,
        { name: "Renamed", base_path: "/docs" },
      ),
      context: ctx(),
      params: { id: tokenId },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Renamed");
    expect(body.base_path).toBe("/docs");
  });

  it("updates can_delegate to boolean", async () => {
    const res = await patchAction({
      request: sessionReq(
        "PATCH",
        `http://localhost/internal/tokens/${tokenId}`,
        { can_delegate: false },
      ),
      context: ctx(),
      params: { id: tokenId },
    });
    const body = await res.json();
    expect(body.can_delegate).toBe(false);
  });

  it("rejects empty patch with 400", async () => {
    const res = await patchAction({
      request: sessionReq(
        "PATCH",
        `http://localhost/internal/tokens/${tokenId}`,
        {},
      ),
      context: ctx(),
      params: { id: tokenId },
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid base_path", async () => {
    const res = await patchAction({
      request: sessionReq(
        "PATCH",
        `http://localhost/internal/tokens/${tokenId}`,
        { base_path: "no-slash" },
      ),
      context: ctx(),
      params: { id: tokenId },
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-owned token", async () => {
    const res = await patchAction({
      request: sessionReq(
        "PATCH",
        "http://localhost/internal/tokens/nonexistent",
        { name: "x" },
      ),
      context: ctx(),
      params: { id: "nonexistent" },
    });
    expect(res.status).toBe(404);
  });
});

// ── DELETE /api/v1/tokens/:id (cookie can revoke own; covered also in api.tokens.integration.test.ts) ──

describe("DELETE token via cookie session", () => {
  it("removes token and returns 204", async () => {
    const res = await deleteAction({
      request: sessionReq(
        "DELETE",
        `http://localhost/api/v1/tokens/${tokenId}`,
      ),
      context: ctx(),
      params: { id: tokenId },
    });
    expect(res.status).toBe(204);

    // Verify gone from listing
    const list = await loader({
      request: new Request("http://localhost/internal/tokens", {
        headers: cookieHeaders(),
      }),
      context: ctx(),
      params: {},
    });
    const body = await list.json();
    expect(body.tokens).toHaveLength(0);
  });
});

// ── POST /internal/tokens/:id/issue (first-time issue) ───

describe("issue token (first time)", () => {
  let unissuedId: string;
  beforeEach(async () => {
    const t = await createUnissuedTestToken(testEnv.db, { userId: USER_ID });
    unissuedId = t.id;
  });

  it("issues an s2_ token with default 90-day expiry", async () => {
    const res = await issueAction({
      request: sessionReq(
        "POST",
        `http://localhost/internal/tokens/${unissuedId}/issue`,
      ),
      context: ctx(),
      params: { id: unissuedId },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toMatch(/^s2_/);
    expect(body.expires_at).toBeDefined();

    const list = await loader({
      request: new Request("http://localhost/internal/tokens", {
        headers: cookieHeaders(),
      }),
      context: ctx(),
      params: {},
    });
    const listBody = await list.json();
    const row = listBody.tokens.find(
      (t: { id: string }) => t.id === unissuedId,
    );
    expect(row.has_active_secret).toBe(true);
  });

  it("accepts custom expires_in_days", async () => {
    const res = await issueAction({
      request: sessionReq(
        "POST",
        `http://localhost/internal/tokens/${unissuedId}/issue`,
        { expires_in_days: 7 },
      ),
      context: ctx(),
      params: { id: unissuedId },
    });
    expect(res.status).toBe(201);
  });

  it("rejects expires_in_days=0", async () => {
    const res = await issueAction({
      request: sessionReq(
        "POST",
        `http://localhost/internal/tokens/${unissuedId}/issue`,
        { expires_in_days: 0 },
      ),
      context: ctx(),
      params: { id: unissuedId },
    });
    expect(res.status).toBe(400);
  });

  it("rejects expires_in_days over 365", async () => {
    const res = await issueAction({
      request: sessionReq(
        "POST",
        `http://localhost/internal/tokens/${unissuedId}/issue`,
        { expires_in_days: 999 },
      ),
      context: ctx(),
      params: { id: unissuedId },
    });
    expect(res.status).toBe(400);
  });

  it("409 when the token already has an active secret", async () => {
    const res = await issueAction({
      request: sessionReq(
        "POST",
        `http://localhost/internal/tokens/${tokenId}/issue`,
      ),
      context: ctx(),
      params: { id: tokenId },
    });
    expect(res.status).toBe(409);
  });
});

// ── POST /internal/tokens/:id/rotate ─────────────────────

describe("rotate token", () => {
  it("replaces the existing secret", async () => {
    const res = await rotateAction({
      request: sessionReq(
        "POST",
        `http://localhost/internal/tokens/${tokenId}/rotate`,
      ),
      context: ctx(),
      params: { id: tokenId },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toMatch(/^s2_/);
    expect(body.expires_at).toBeDefined();
  });

  it("409 when the token has no active secret", async () => {
    const t = await createUnissuedTestToken(testEnv.db, { userId: USER_ID });
    const res = await rotateAction({
      request: sessionReq(
        "POST",
        `http://localhost/internal/tokens/${t.id}/rotate`,
      ),
      context: ctx(),
      params: { id: t.id },
    });
    expect(res.status).toBe(409);
  });
});

// ── DELETE /internal/tokens/:id/secret (revoke) ──────────

describe("revoke token secret", () => {
  it("clears token_hash and expires_at", async () => {
    const res = await secretAction({
      request: sessionReq(
        "DELETE",
        `http://localhost/internal/tokens/${tokenId}/secret`,
      ),
      context: ctx(),
      params: { id: tokenId },
    });
    expect(res.status).toBe(204);

    const list = await loader({
      request: new Request("http://localhost/internal/tokens", {
        headers: cookieHeaders(),
      }),
      context: ctx(),
      params: {},
    });
    const body = await list.json();
    expect(body.tokens[0].has_active_secret).toBe(false);
  });
});

// ── PUT /internal/tokens/:id/access-paths ────────────────

describe("replace access paths", () => {
  it("replaces all access paths", async () => {
    const res = await accessPathsAction({
      request: sessionReq(
        "PUT",
        `http://localhost/internal/tokens/${tokenId}/access-paths`,
        {
          access_paths: [
            { path: "docs", access: "write" },
            { path: "photos", access: "read" },
          ],
        },
      ),
      context: ctx(),
      params: { id: tokenId },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_paths).toHaveLength(2);

    // Verify in DB
    const paths = await testEnv.db.query<{ path: string }>(
      "SELECT path FROM grant_paths WHERE grant_id = $1 ORDER BY path",
      [tokenId],
    );
    expect(paths.map((r) => r.path)).toEqual(["docs", "photos"]);
  });

  it("rejects access_paths=[] with 400 and leaves existing rows untouched", async () => {
    // a token with no access_paths authenticates but every
    // file/WebDAV request 403s. The API now refuses to persist that state.
    const res = await accessPathsAction({
      request: sessionReq(
        "PUT",
        `http://localhost/internal/tokens/${tokenId}/access-paths`,
        { access_paths: [] },
      ),
      context: ctx(),
      params: { id: tokenId },
    });
    expect(res.status).toBe(400);

    const paths = await testEnv.db.query(
      "SELECT * FROM grant_paths WHERE grant_id = $1",
      [tokenId],
    );
    expect(paths.length).toBeGreaterThan(0);
  });

  it("rejects invalid JSON", async () => {
    const h = cookieHeaders();
    h.set("Content-Type", "application/json");
    const res = await accessPathsAction({
      request: new Request(
        `http://localhost/internal/tokens/${tokenId}/access-paths`,
        { method: "PUT", headers: h, body: "not json" },
      ),
      context: ctx(),
      params: { id: tokenId },
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-owned token", async () => {
    const res = await accessPathsAction({
      request: sessionReq(
        "PUT",
        "http://localhost/internal/tokens/fake/access-paths",
        // Use a non-empty body so the request reaches the ownership check;
        // empty access_paths short-circuits at validation.
        { access_paths: [{ path: "", access: "write" }] },
      ),
      context: ctx(),
      params: { id: "fake" },
    });
    expect(res.status).toBe(404);
  });
});

// Bearer rejection on /internal/* is enforced by app/lib/gateway/middleware.ts middleware
// (covered by app/lib/gateway/middleware.test.ts). Integration tests bypass the
// middleware so we don't re-test that contract at the handler level.
