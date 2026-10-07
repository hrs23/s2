// @ts-nocheck
//
// Integration tests for /internal/revisions GET (list) + /internal/files-restore
// (POST). These endpoints are cookie-only via the app/lib/gateway/middleware.ts middleware
// in production; we exercise the handlers directly with Bearer auth context
// here because the service-layer accepts both auth types — the middleware
// rejection is covered by app/lib/gateway/middleware.test.ts.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  bearerHeader,
  cleanTestEnv,
  createTestEnv,
  createTestUser,
  disposeTestEnv,
  issueTestToken,
  type TestEnv,
  testLoadContext,
} from "~/test/integration-helpers";
import { action as filesAction } from "../api.files.$";
import { action as restoreAction } from "../internal.files-restore";
import { loader as versionsLoader } from "../internal.revisions";

let testEnv: TestEnv;
let token: string;
const USER_ID = "user_versions_test";

function ctx() {
  return testLoadContext(testEnv);
}

function req(
  method: string,
  url: string,
  opts: { body?: BodyInit; headers?: Record<string, string> } = {},
): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: {
      Authorization: bearerHeader(token),
      ...opts.headers,
    },
    body: opts.body,
  });
}

async function uploadFile(path: string, content: string) {
  return filesAction({
    request: req("PUT", `/api/v1/files/${path}`, {
      body: content,
      headers: { "Content-Type": "text/plain" },
    }),
    context: ctx(),
    params: { "*": path },
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
    limits: { revision_limit: 30 },
  });
  const tok = await issueTestToken(testEnv.db, { userId: user.id });
  token = tok.rawToken;
});

describe("GET /internal/revisions?path=...", () => {
  it("returns 401 without auth", async () => {
    const r = new Request("http://localhost/internal/revisions?path=test.txt", {
      method: "GET",
    });
    const res = await versionsLoader({
      request: r,
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 when path query param is missing", async () => {
    const res = await versionsLoader({
      request: req("GET", "/internal/revisions"),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent path", async () => {
    const res = await versionsLoader({
      request: req("GET", "/internal/revisions?path=nonexistent.txt"),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(404);
  });

  it("lists revisions for a file", async () => {
    await uploadFile("versioned.txt", "v1");

    const res = await versionsLoader({
      request: req("GET", "/internal/revisions?path=versioned.txt"),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revisions).toHaveLength(1);
    expect(body.revisions[0].is_current).toBe(true);
  });

  it("shows multiple revisions after re-upload", async () => {
    await uploadFile("multi.txt", "v1");
    await uploadFile("multi.txt", "v2");

    const res = await versionsLoader({
      request: req("GET", "/internal/revisions?path=multi.txt"),
      context: ctx(),
      params: {},
    });
    const body = await res.json();
    expect(body.revisions.length).toBeGreaterThanOrEqual(2);
    const current = body.revisions.find(
      (r: { is_current: boolean }) => r.is_current,
    );
    expect(current).toBeDefined();
  });
});

describe("POST /internal/files-restore", () => {
  it("returns 401 without auth", async () => {
    const r = new Request("http://localhost/internal/files-restore", {
      method: "POST",
      body: JSON.stringify({ path: "test.txt", revision_id: "yyy" }),
    });
    const res = await restoreAction({
      request: r,
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-existent path", async () => {
    const res = await restoreAction({
      request: req("POST", "/internal/files-restore", {
        body: JSON.stringify({ path: "nonexistent.txt", revision_id: "yyy" }),
        headers: { "Content-Type": "application/json" },
      }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(404);
  });

  it("restores a previous version", async () => {
    await uploadFile("restore-ver.txt", "v1");
    await uploadFile("restore-ver.txt", "v2");

    const versRes = await versionsLoader({
      request: req("GET", "/internal/revisions?path=restore-ver.txt"),
      context: ctx(),
      params: {},
    });
    const { revisions } = await versRes.json();
    const oldRevision = revisions.find(
      (r: { is_current: boolean }) => !r.is_current,
    );
    expect(oldRevision).toBeDefined();

    const res = await restoreAction({
      request: req("POST", "/internal/files-restore", {
        body: JSON.stringify({
          path: "restore-ver.txt",
          revision_id: oldRevision.id,
        }),
        headers: { "Content-Type": "application/json" },
      }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(200);

    const versRes2 = await versionsLoader({
      request: req("GET", "/internal/revisions?path=restore-ver.txt"),
      context: ctx(),
      params: {},
    });
    const body2 = await versRes2.json();
    const current = body2.revisions.find(
      (r: { is_current: boolean }) => r.is_current,
    );
    expect(current.id).toBe(oldRevision.id);
  });

  it("returns 405 for non-POST methods", async () => {
    const res = await restoreAction({
      request: req("GET", "/internal/files-restore"),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(405);
  });
});

describe("version pruning", () => {
  it("prunes excess revisions when revision_limit is set", async () => {
    for (let i = 0; i <= 30; i++) {
      await uploadFile("many.txt", `v${i}`);
    }

    const versRes = await versionsLoader({
      request: req("GET", "/internal/revisions?path=many.txt"),
      context: ctx(),
      params: {},
    });
    const body = await versRes.json();
    expect(body.revisions).toHaveLength(30);
  });
});
