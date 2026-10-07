// @ts-nocheck
// @vitest-environment node
// Integration tests for OAuth grant management API
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
import { loader } from "../internal.oauth-grants";
import { action as grantAction } from "../internal.oauth-grants.$id";

const deleteAction = grantAction;
const patchAction = grantAction;

let testEnv: TestEnv;
const USER_ID = "user_oauth_api";
const CLIENT_ID = "test-client-x";
const REDIRECT_URI = "http://127.0.0.1/cb";

function ctx() {
  return testLoadContext(testEnv);
}

async function sessionRequest(
  url: string,
  init: RequestInit = {},
): Promise<Request> {
  const cookie = await sessionCookieHeader(USER_ID, testEnv.env);
  const headers = new Headers(init.headers);
  headers.set("Cookie", cookie);
  return new Request(url, { ...init, headers });
}

async function seedOAuthGrant(): Promise<string> {
  const grantId = `grt_${Date.now()}`;
  await testEnv.db.execute(
    `INSERT INTO grants (id, user_id, base_path, created_at)
     VALUES ($1, $2, '/', now())`,
    [grantId, USER_ID],
  );
  await testEnv.db.execute(
    `INSERT INTO oauth_grants (grant_id, user_id, oauth_client_id, oauth_requested_scopes)
     VALUES ($1, $2, $3, ARRAY['files'])`,
    [grantId, USER_ID, CLIENT_ID],
  );
  await testEnv.db.execute(
    `INSERT INTO grant_paths (grant_id, path, access)
     VALUES ($1, 'notes', 'read')`,
    [grantId],
  );
  await testEnv.db.execute(
    `INSERT INTO access_tokens (grant_id, user_id, token_hash, expires_at)
     SELECT id, user_id, 'hash_abc', now() + INTERVAL '1 hour'
     FROM grants WHERE id = $1`,
    [grantId],
  );
  return grantId;
}

beforeAll(async () => {
  testEnv = await createTestEnv();
});

afterAll(async () => {
  await disposeTestEnv(testEnv);
});

beforeEach(async () => {
  await cleanTestEnv(testEnv);
  await createTestUser(testEnv.db, { id: USER_ID });
  await testEnv.db.execute(
    `INSERT INTO oauth_clients (id, client_name, redirect_uris, token_endpoint_auth_method)
     VALUES ($1, 'Test App', ARRAY[$2], 'none')`,
    [CLIENT_ID, REDIRECT_URI],
  );
});

describe("GET /internal/oauth-grants", () => {
  it("requires user session", async () => {
    const res = await loader({
      request: new Request("http://localhost/internal/oauth-grants"),
      context: ctx(),
      params: {},
    } as Parameters<typeof loader>[0]);
    expect(res.status).toBe(401);
  });

  it("returns the user's OAuth grants with paths", async () => {
    await seedOAuthGrant();
    const res = await loader({
      request: await sessionRequest("http://localhost/internal/oauth-grants"),
      context: ctx(),
      params: {},
    } as Parameters<typeof loader>[0]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grants: unknown[] };
    expect(body.grants).toHaveLength(1);
    const g = body.grants[0] as Record<string, unknown>;
    expect(g.client_id).toBe(CLIENT_ID);
    expect(g.client_name).toBe("Test App");
    expect(g.paths).toEqual([{ path: "notes", access: "read" }]);
  });

  it("does not return manual / delegated grants", async () => {
    // Manual grant (user_grants only — no oauth_grants row)
    await testEnv.db.execute(
      `INSERT INTO grants (id, user_id, base_path, created_at)
       VALUES ('tok_manual', $1, '/', now())`,
      [USER_ID],
    );
    await testEnv.db.execute(
      `INSERT INTO user_grants (grant_id, user_id, name, can_delegate)
       VALUES ('tok_manual', $1, 'Manual', false)`,
      [USER_ID],
    );
    const res = await loader({
      request: await sessionRequest("http://localhost/internal/oauth-grants"),
      context: ctx(),
      params: {},
    } as Parameters<typeof loader>[0]);
    const body = await res.json();
    expect(body.grants).toEqual([]);
  });
});

describe("DELETE /internal/oauth-grants/:id", () => {
  it("revokes the grant and cascades credentials", async () => {
    const grantId = await seedOAuthGrant();
    const res = await deleteAction({
      request: await sessionRequest(
        `http://localhost/internal/oauth-grants/${grantId}`,
        { method: "DELETE" },
      ),
      context: ctx(),
      params: { id: grantId },
    } as Parameters<typeof deleteAction>[0]);
    expect(res.status).toBe(204);

    const remaining = await testEnv.db.query(
      "SELECT id FROM grants WHERE id = $1",
      [grantId],
    );
    expect(remaining).toHaveLength(0);
    const at = await testEnv.db.query(
      "SELECT grant_id FROM access_tokens WHERE grant_id = $1",
      [grantId],
    );
    expect(at).toHaveLength(0);
  });

  it("404 when the grant belongs to another user", async () => {
    const otherUser = "user_other";
    await createTestUser(testEnv.db, { id: otherUser });
    await testEnv.db.execute(
      `INSERT INTO grants (id, user_id, base_path, created_at)
       VALUES ('grt_other', $1, '/', now())`,
      [otherUser],
    );
    await testEnv.db.execute(
      `INSERT INTO oauth_grants (grant_id, user_id, oauth_client_id, oauth_requested_scopes)
       VALUES ('grt_other', $1, $2, ARRAY['files'])`,
      [otherUser, CLIENT_ID],
    );
    const res = await deleteAction({
      request: await sessionRequest(
        "http://localhost/internal/oauth-grants/grt_other",
        { method: "DELETE" },
      ),
      context: ctx(),
      params: { id: "grt_other" },
    } as Parameters<typeof deleteAction>[0]);
    expect(res.status).toBe(404);

    const stillThere = await testEnv.db.query(
      "SELECT id FROM grants WHERE id = 'grt_other'",
    );
    expect(stillThere).toHaveLength(1);
  });

  it("rejects non-DELETE", async () => {
    const grantId = await seedOAuthGrant();
    const res = await deleteAction({
      request: await sessionRequest(
        `http://localhost/internal/oauth-grants/${grantId}`,
        { method: "POST" },
      ),
      context: ctx(),
      params: { id: grantId },
    } as Parameters<typeof deleteAction>[0]);
    expect(res.status).toBe(405);
  });

  it("requires user session", async () => {
    const grantId = await seedOAuthGrant();
    const res = await deleteAction({
      request: new Request(
        `http://localhost/internal/oauth-grants/${grantId}`,
        {
          method: "DELETE",
        },
      ),
      context: ctx(),
      params: { id: grantId },
    } as Parameters<typeof deleteAction>[0]);
    expect(res.status).toBe(401);
  });
});

describe("PATCH /internal/oauth-grants/:id", () => {
  async function patchRequest(grantId: string, body: unknown) {
    return sessionRequest(`http://localhost/internal/oauth-grants/${grantId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("updates base_path and replaces access paths", async () => {
    const grantId = await seedOAuthGrant();
    const res = await patchAction({
      request: await patchRequest(grantId, {
        base_path: "/work",
        paths: [
          { path: "docs", access: "write" },
          { path: "inbox", access: "read" },
        ],
      }),
      context: ctx(),
      params: { id: grantId },
    } as Parameters<typeof patchAction>[0]);
    expect(res.status).toBe(204);

    const grant = await testEnv.db.queryOne(
      "SELECT base_path FROM grants WHERE id = $1",
      [grantId],
    );
    expect(grant.base_path).toBe("/work");

    const paths = await testEnv.db.query(
      "SELECT path, access FROM grant_paths WHERE grant_id = $1 ORDER BY path",
      [grantId],
    );
    expect(paths).toEqual([
      { path: "docs", access: "write" },
      { path: "inbox", access: "read" },
    ]);
  });

  it("does not invalidate the existing access_token", async () => {
    const grantId = await seedOAuthGrant();
    const before = await testEnv.db.query(
      "SELECT token_hash FROM access_tokens WHERE grant_id = $1",
      [grantId],
    );
    const res = await patchAction({
      request: await patchRequest(grantId, {
        base_path: "/",
        paths: [{ path: "photos", access: "write" }],
      }),
      context: ctx(),
      params: { id: grantId },
    } as Parameters<typeof patchAction>[0]);
    expect(res.status).toBe(204);

    const after = await testEnv.db.query(
      "SELECT token_hash FROM access_tokens WHERE grant_id = $1",
      [grantId],
    );
    expect(after).toHaveLength(1);
    expect(after[0].token_hash).toBe(before[0].token_hash);
  });

  it("404 when the grant belongs to another user", async () => {
    const otherUser = "user_other";
    await createTestUser(testEnv.db, { id: otherUser });
    await testEnv.db.execute(
      `INSERT INTO grants (id, user_id, base_path, created_at)
       VALUES ('grt_other_p', $1, '/', now())`,
      [otherUser],
    );
    await testEnv.db.execute(
      `INSERT INTO oauth_grants (grant_id, user_id, oauth_client_id, oauth_requested_scopes)
       VALUES ('grt_other_p', $1, $2, ARRAY['files'])`,
      [otherUser, CLIENT_ID],
    );
    const res = await patchAction({
      request: await patchRequest("grt_other_p", {
        base_path: "/",
        paths: [{ path: "x", access: "read" }],
      }),
      context: ctx(),
      params: { id: "grt_other_p" },
    } as Parameters<typeof patchAction>[0]);
    expect(res.status).toBe(404);
  });

  it("400 when paths is empty", async () => {
    const grantId = await seedOAuthGrant();
    const res = await patchAction({
      request: await patchRequest(grantId, { base_path: "/", paths: [] }),
      context: ctx(),
      params: { id: grantId },
    } as Parameters<typeof patchAction>[0]);
    expect(res.status).toBe(400);
  });

  it("400 when base_path is invalid", async () => {
    const grantId = await seedOAuthGrant();
    const res = await patchAction({
      request: await patchRequest(grantId, {
        base_path: "no-leading-slash",
        paths: [{ path: "x", access: "read" }],
      }),
      context: ctx(),
      params: { id: grantId },
    } as Parameters<typeof patchAction>[0]);
    expect(res.status).toBe(400);
  });

  it("400 when body is malformed JSON", async () => {
    const grantId = await seedOAuthGrant();
    const req = await sessionRequest(
      `http://localhost/internal/oauth-grants/${grantId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      },
    );
    const res = await patchAction({
      request: req,
      context: ctx(),
      params: { id: grantId },
    } as Parameters<typeof patchAction>[0]);
    expect(res.status).toBe(400);
  });

  it("requires user session", async () => {
    const grantId = await seedOAuthGrant();
    const res = await patchAction({
      request: new Request(
        `http://localhost/internal/oauth-grants/${grantId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            base_path: "/",
            paths: [{ path: "x", access: "read" }],
          }),
        },
      ),
      context: ctx(),
      params: { id: grantId },
    } as Parameters<typeof patchAction>[0]);
    expect(res.status).toBe(401);
  });
});
