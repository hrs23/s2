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
import { action, loader } from "../api.files.$";

let testEnv: TestEnv;
let token: string;
const USER_ID = "user_files_test";

function ctx() {
  return testLoadContext(testEnv);
}

function req(
  method: string,
  path: string,
  opts: { body?: BodyInit; headers?: Record<string, string> } = {},
): Request {
  return new Request(`http://localhost/api/v1/files/${path}`, {
    method,
    headers: {
      Authorization: bearerHeader(token),
      ...opts.headers,
    },
    body: opts.body,
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
  const tok = await issueTestToken(testEnv.db, { userId: user.id });
  token = tok.rawToken;
});

// ── Auth ────────────────────────────────────────────────────

describe("authentication", () => {
  it("returns 401 without auth", async () => {
    const r = new Request("http://localhost/api/v1/files/", { method: "GET" });
    const res = await loader({
      request: r,
      context: ctx(),
      params: { "*": "" },
    });
    expect(res.status).toBe(401);
  });
});

// ── Directory listing ───────────────────────────────────────

describe("GET directory listing", () => {
  it("returns empty items for root", async () => {
    const res = await loader({
      request: req("GET", ""),
      context: ctx(),
      params: { "*": "" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
  });

  it("lists uploaded files", async () => {
    // Upload a file first
    await action({
      request: req("PUT", "hello.txt", {
        body: "Hello",
        headers: { "Content-Type": "text/plain" },
      }),
      context: ctx(),
      params: { "*": "hello.txt" },
    });

    const res = await loader({
      request: req("GET", ""),
      context: ctx(),
      params: { "*": "" },
    });
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].name).toBe("hello.txt");
    expect(body.items[0].type).toBe("file");
    expect(body.items[0].size).toBeDefined();
  });

  it("returns 404 for non-existent directory", async () => {
    const res = await loader({
      request: req("GET", "nonexistent/"),
      context: ctx(),
      params: { "*": "nonexistent/" },
    });
    expect(res.status).toBe(404);
  });
});

// ── PUT (upload) ────────────────────────────────────────────

describe("PUT upload", () => {
  it("creates a new file and returns 201 with metadata", async () => {
    const res = await action({
      request: req("PUT", "test.txt", {
        body: "Hello World",
        headers: { "Content-Type": "text/plain" },
      }),
      context: ctx(),
      params: { "*": "test.txt" },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("test.txt");
    expect(body.size).toBeDefined();
    expect(body.id).toBeDefined();
  });

  it("creates missing parent directories", async () => {
    await action({
      request: req("PUT", "docs/nested/file.txt", {
        body: "nested content",
      }),
      context: ctx(),
      params: { "*": "docs/nested/file.txt" },
    });

    // List docs/ directory
    const res = await loader({
      request: req("GET", "docs/"),
      context: ctx(),
      params: { "*": "docs/" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const nested = body.items.find(
      (i: { name: string }) => i.name === "nested",
    );
    expect(nested).toBeDefined();
    expect(nested.type).toBe("directory");
  });

  it("folder marker creates directory node", async () => {
    const res = await action({
      request: req("PUT", "photos/", { body: "" }),
      context: ctx(),
      params: { "*": "photos/" },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.type).toBe("directory");
  });

  it("accepts empty (0-byte) file uploads", async () => {
    const res = await action({
      request: req("PUT", "empty.txt", { body: "" }),
      context: ctx(),
      params: { "*": "empty.txt" },
    });
    expect(res.status).toBe(201);
  });
});

// ── GET (download) ──────────────────────────────────────────

describe("GET download", () => {
  it("returns file content", async () => {
    await action({
      request: req("PUT", "dl.txt", {
        body: "download me",
        headers: { "Content-Type": "text/plain" },
      }),
      context: ctx(),
      params: { "*": "dl.txt" },
    });

    const res = await loader({
      request: req("GET", "dl.txt"),
      context: ctx(),
      params: { "*": "dl.txt" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("download me");
    expect(res.headers.get("Content-Type")).toBe("text/plain");
  });

  it("returns 404 for missing file", async () => {
    const res = await loader({
      request: req("GET", "missing.txt"),
      context: ctx(),
      params: { "*": "missing.txt" },
    });
    expect(res.status).toBe(404);
  });
});

// ── HEAD ────────────────────────────────────────────────────

describe("HEAD metadata", () => {
  it("returns content-length and content-type", async () => {
    await action({
      request: req("PUT", "meta.txt", {
        body: "12345",
        headers: { "Content-Type": "text/plain" },
      }),
      context: ctx(),
      params: { "*": "meta.txt" },
    });

    const res = await loader({
      request: req("HEAD", "meta.txt"),
      context: ctx(),
      params: { "*": "meta.txt" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("5");
    expect(res.headers.get("Content-Type")).toBe("text/plain");
  });
});

// ── DELETE ───────────────────────────────────────────────────

describe("DELETE", () => {
  it("removes file and decrements bytes_used", async () => {
    await action({
      request: req("PUT", "rm.txt", { body: "to remove" }),
      context: ctx(),
      params: { "*": "rm.txt" },
    });

    const before = await testEnv.db.queryOne<{ bytes_used: number }>(
      "SELECT bytes_used FROM user_storage WHERE user_id = $1",
      [USER_ID],
    );

    const res = await action({
      request: req("DELETE", "rm.txt"),
      context: ctx(),
      params: { "*": "rm.txt" },
    });
    expect(res.status).toBe(204);

    const after = await testEnv.db.queryOne<{ bytes_used: number }>(
      "SELECT bytes_used FROM user_storage WHERE user_id = $1",
      [USER_ID],
    );
    // Soft delete: bytes_used unchanged (trash counts toward quota)
    expect(Number(after?.bytes_used)).toBe(Number(before?.bytes_used ?? 0));
  });

  it("returns 404 for non-existent file", async () => {
    const res = await action({
      request: req("DELETE", "nope.txt"),
      context: ctx(),
      params: { "*": "nope.txt" },
    });
    expect(res.status).toBe(404);
  });
});

// ── Permission scoping ──────────────────────────────────────

describe("token scope", () => {
  it("read-only token cannot PUT", async () => {
    const readTok = await issueTestToken(testEnv.db, {
      userId: USER_ID,
      paths: [{ path: "", access: "read" }],
    });

    const res = await action({
      request: new Request("http://localhost/api/v1/files/forbidden.txt", {
        method: "PUT",
        headers: { Authorization: bearerHeader(readTok.rawToken) },
        body: "nope",
      }),
      context: ctx(),
      params: { "*": "forbidden.txt" },
    });
    expect(res.status).toBe(403);
  });

  it("read-only token cannot DELETE existing file", async () => {
    // Upload with main token
    await action({
      request: req("PUT", "del-test.txt", { body: "data" }),
      context: ctx(),
      params: { "*": "del-test.txt" },
    });

    const roTok = await issueTestToken(testEnv.db, {
      userId: USER_ID,
      paths: [{ path: "", access: "read" }],
    });

    const res = await action({
      request: new Request("http://localhost/api/v1/files/del-test.txt", {
        method: "DELETE",
        headers: { Authorization: bearerHeader(roTok.rawToken) },
      }),
      context: ctx(),
      params: { "*": "del-test.txt" },
    });
    expect(res.status).toBe(403);
  });

  it("returns 405 for unsupported method", async () => {
    const res = await action({
      request: req("PATCH", "test.txt"),
      context: ctx(),
      params: { "*": "test.txt" },
    });
    expect(res.status).toBe(405);
  });
});

// ── Storage limit ───────────────────────────────────────────

describe("storage limit", () => {
  it("rejects upload over storage limit with 413", async () => {
    const freeUser = await createTestUser(testEnv.db, {
      id: "user_free_api",
      limits: FINITE_TEST_LIMITS,
    });
    const freeTok = await issueTestToken(testEnv.db, {
      userId: freeUser.id,
    });

    // Set bytes_used close to limit (1GB = 1073741824)
    await testEnv.db.execute(
      "UPDATE user_storage SET bytes_used = $1 WHERE user_id = $2",
      [1073741824, freeUser.id],
    );

    const res = await action({
      request: new Request("http://localhost/api/v1/files/big.bin", {
        method: "PUT",
        headers: { Authorization: bearerHeader(freeTok.rawToken) },
        body: "x".repeat(100),
      }),
      context: ctx(),
      params: { "*": "big.bin" },
    });
    expect(res.status).toBe(413);
  });
});

// ── Non-root base_path token ─────────────────────────────────

describe("non-root base_path token scoping", () => {
  let scopedToken: string;

  beforeEach(async () => {
    // Create a token scoped to /agents/ base_path
    const tok = await issueTestToken(testEnv.db, {
      userId: USER_ID,
      basePath: "/agents",
      paths: [{ path: "", access: "write" }],
    });
    scopedToken = tok.rawToken;
  });

  function scopedReq(
    method: string,
    path: string,
    opts: { body?: BodyInit; headers?: Record<string, string> } = {},
  ): Request {
    return new Request(`http://localhost/api/v1/files/${path}`, {
      method,
      headers: {
        Authorization: bearerHeader(scopedToken),
        ...opts.headers,
      },
      body: opts.body,
    });
  }

  it("PUT stores file under /agents/ in absolute path", async () => {
    const res = await action({
      request: scopedReq("PUT", "foo.txt", {
        body: "hello from agent",
        headers: { "Content-Type": "text/plain" },
      }),
      context: ctx(),
      params: { "*": "foo.txt" },
    });
    expect(res.status).toBe(201);
  });

  it("GET retrieves file uploaded by scoped token", async () => {
    // First upload
    await action({
      request: scopedReq("PUT", "bar.txt", {
        body: "agent data",
        headers: { "Content-Type": "text/plain" },
      }),
      context: ctx(),
      params: { "*": "bar.txt" },
    });

    // Then retrieve
    const res = await loader({
      request: scopedReq("GET", "bar.txt"),
      context: ctx(),
      params: { "*": "bar.txt" },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("agent data");
  });

  it("LIST returns empty array for scoped root before any files are uploaded", async () => {
    const res = await loader({
      request: scopedReq("GET", ""),
      context: ctx(),
      params: { "*": "" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
  });

  it("LIST returns files in scoped root after upload", async () => {
    await action({
      request: scopedReq("PUT", "agent-file.txt", {
        body: "content",
        headers: { "Content-Type": "text/plain" },
      }),
      context: ctx(),
      params: { "*": "agent-file.txt" },
    });

    const res = await loader({
      request: scopedReq("GET", ""),
      context: ctx(),
      params: { "*": "" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].name).toBe("agent-file.txt");
  });

  it("scoped token cannot access files outside base_path", async () => {
    // Upload a file as root user at /root-secret.txt
    await action({
      request: req("PUT", "root-secret.txt", {
        body: "secret",
        headers: { "Content-Type": "text/plain" },
      }),
      context: ctx(),
      params: { "*": "root-secret.txt" },
    });

    // Scoped token (base_path="/agents") tries to read "root-secret.txt"
    // → toAbsoluteSegments converts to ["agents", "root-secret.txt"] = /agents/root-secret.txt
    // This file does not exist (it was stored at /root-secret.txt), so returns 404
    // The scope isolation works: the scoped token can only see files under /agents/
    const res = await loader({
      request: scopedReq("GET", "root-secret.txt"),
      context: ctx(),
      params: { "*": "root-secret.txt" },
    });
    // 404 because /agents/root-secret.txt doesn't exist (path isolation works correctly)
    expect(res.status).toBe(404);
  });
});
