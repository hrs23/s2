// @ts-nocheck
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAppContext } from "~/lib/app-context.server";
import {
  basicAuthHeader,
  cleanTestEnv,
  createTestEnv,
  createTestUser,
  disposeTestEnv,
  FINITE_TEST_LIMITS,
  issueTestToken,
  type TestEnv,
} from "~/test/integration-helpers";
import { handleDavRequest } from "../dav";

let testEnv: TestEnv;
let token: string; // raw s2_ token for auth
const USER_ID = "user_dav_test";

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

function dav(
  method: string,
  path: string,
  opts: { body?: BodyInit; headers?: Record<string, string> } = {},
): Request {
  return new Request(`http://localhost/dav${path}`, {
    method,
    headers: {
      Authorization: basicAuthHeader(token),
      ...opts.headers,
    },
    body: opts.body,
  });
}

function ctx() {
  return {
    appContext: createAppContext(testEnv.env),
    runtime: { env: testEnv.env },
  };
}

// ── Auth ────────────────────────────────────────────────────

describe("authentication", () => {
  it("returns 401 with WWW-Authenticate for unauthenticated requests", async () => {
    const req = new Request("http://localhost/dav/", { method: "PROPFIND" });
    const res = await handleDavRequest(req, ctx());

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="s2"');
  });

  it("OPTIONS does not require auth", async () => {
    const req = new Request("http://localhost/dav/", { method: "OPTIONS" });
    const res = await handleDavRequest(req, ctx());

    expect(res.status).toBe(204);
    expect(res.headers.get("DAV")).toBe("1,2,3");
    expect(res.headers.get("Allow")).toContain("PROPFIND");
    expect(res.headers.get("Allow")).toContain("LOCK");
    expect(res.headers.get("Allow")).toContain("UNLOCK");
  });
});

// ── Path traversal ──────────────────────────────────────────

describe("path traversal", () => {
  it("rejects null bytes in path with 400", async () => {
    const res = await handleDavRequest(dav("PROPFIND", "/test%00.txt"), ctx());
    expect(res.status).toBe(400);
  });

  // Stub handlers (LOCK/UNLOCK/PROPPATCH) never reach FileService, so the
  // dispatcher-level path check is the only gate that rejects malformed paths.
  // Regression guard: removing early validation must not let null bytes (or
  // URL-parser-surviving traversal patterns) slip into response bodies.
  //
  // Note on encodings: `/..` is resolved by the WHATWG URL parser; so is
  // `/%2E%2E/`. The only patterns that survive URL parsing and reach
  // validation are `%00` (null byte) and `%2E%2E%2F` (encoded slash keeps the
  // segment intact).
  it.each([
    ["LOCK", "/file%00.txt"],
    ["UNLOCK", "/file%00.txt"],
    ["PROPPATCH", "/file%00.txt"],
    ["LOCK", "/%2E%2E%2Fevil.txt"],
    ["PROPPATCH", "/%2E%2E%2Fevil.txt"],
  ])("rejects malformed path in %s with 400", async (method, path) => {
    const res = await handleDavRequest(dav(method, path), ctx());
    expect(res.status).toBe(400);
  });

  it("rejects malformed COPY destination with 400 (not 409)", async () => {
    // The in-tree descendant check runs on raw paths; a traversal pattern in
    // the destination must be rejected as 400, not conflated with 409 Conflict.
    await handleDavRequest(dav("PUT", "/src.txt", { body: "data" }), ctx());
    const res = await handleDavRequest(
      dav("COPY", "/src.txt", {
        headers: { Destination: "http://localhost/dav/%2E%2E%2Fevil.txt" },
      }),
      ctx(),
    );
    expect(res.status).toBe(400);
  });
});

// ── PROPFIND ────────────────────────────────────────────────

describe("PROPFIND", () => {
  it("returns 207 XML for root with children", async () => {
    await handleDavRequest(
      dav("PUT", "/hello.txt", { body: "Hello World" }),
      ctx(),
    );

    const res = await handleDavRequest(
      dav("PROPFIND", "/", { headers: { Depth: "1" } }),
      ctx(),
    );

    expect(res.status).toBe(207);
    expect(res.headers.get("Content-Type")).toContain("application/xml");
    const xml = await res.text();
    expect(xml).toContain("hello.txt");
  });

  it("Depth: 0 excludes children", async () => {
    await handleDavRequest(dav("PUT", "/file.txt", { body: "content" }), ctx());

    const res = await handleDavRequest(
      dav("PROPFIND", "/", { headers: { Depth: "0" } }),
      ctx(),
    );

    expect(res.status).toBe(207);
    const xml = await res.text();
    expect(xml).not.toContain("file.txt");
  });

  it("Depth: infinity returns 403", async () => {
    const res = await handleDavRequest(
      dav("PROPFIND", "/", { headers: { Depth: "infinity" } }),
      ctx(),
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 for non-existent path", async () => {
    const res = await handleDavRequest(dav("PROPFIND", "/nonexistent/"), ctx());
    expect(res.status).toBe(404);
  });

  it("includes getcontenttype and getetag for files", async () => {
    await handleDavRequest(
      dav("PUT", "/typed.txt", {
        body: "content",
        headers: { "Content-Type": "text/plain" },
      }),
      ctx(),
    );

    const res = await handleDavRequest(
      dav("PROPFIND", "/", { headers: { Depth: "1" } }),
      ctx(),
    );

    const xml = await res.text();
    expect(xml).toContain("<D:getcontenttype>text/plain</D:getcontenttype>");
    expect(xml).toContain("<D:getetag>");
  });

  it("includes supportedlock with lock entries", async () => {
    const res = await handleDavRequest(
      dav("PROPFIND", "/", { headers: { Depth: "0" } }),
      ctx(),
    );

    const xml = await res.text();
    expect(xml).toContain("<D:supportedlock>");
    expect(xml).toContain("<D:exclusive/>");
    expect(xml).toContain("<D:shared/>");
  });
});

describe("PROPFIND on single file", () => {
  it("returns file metadata for a single file", async () => {
    await handleDavRequest(
      dav("PUT", "/single.txt", {
        body: "file content",
        headers: { "Content-Type": "text/plain" },
      }),
      ctx(),
    );

    const res = await handleDavRequest(
      dav("PROPFIND", "/single.txt", { headers: { Depth: "0" } }),
      ctx(),
    );

    expect(res.status).toBe(207);
    expect(res.headers.get("Content-Type")).toContain("application/xml");
    const xml = await res.text();
    expect(xml).toContain("/dav/single.txt");
    expect(xml).not.toContain("<D:collection");
    expect(xml).toContain("<D:getcontenttype>text/plain</D:getcontenttype>");
    expect(xml).toContain("<D:getetag>");
  });
});

// ── PUT / GET / HEAD ────────────────────────────────────────

describe("GET error paths", () => {
  it("returns 405 for root GET (directory)", async () => {
    const res = await handleDavRequest(dav("GET", "/"), ctx());
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toContain("PROPFIND");
  });

  it("returns 404 for missing file", async () => {
    const res = await handleDavRequest(dav("GET", "/missing.txt"), ctx());
    expect(res.status).toBe(404);
  });

  it("returns 405 for directory GET", async () => {
    await handleDavRequest(dav("MKCOL", "/getdir"), ctx());
    const res = await handleDavRequest(dav("GET", "/getdir"), ctx());
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toContain("PROPFIND");
  });
});

describe("HEAD error paths", () => {
  it("returns 405 for root HEAD (directory)", async () => {
    const res = await handleDavRequest(dav("HEAD", "/"), ctx());
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toContain("PROPFIND");
  });

  it("returns 404 for missing file HEAD", async () => {
    const res = await handleDavRequest(dav("HEAD", "/missing.txt"), ctx());
    expect(res.status).toBe(404);
  });

  it("returns 405 for directory HEAD", async () => {
    await handleDavRequest(dav("MKCOL", "/headdir"), ctx());
    const res = await handleDavRequest(dav("HEAD", "/headdir"), ctx());
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toContain("PROPFIND");
  });

  it("scoped token GET on root returns 405", async () => {
    const scopedTok = await issueTestToken(testEnv.db, {
      userId: USER_ID,
      paths: [{ path: "docs", access: "read" }],
    });
    const req = new Request("http://localhost/dav/", {
      method: "GET",
      headers: { Authorization: basicAuthHeader(scopedTok.rawToken) },
    });
    const res = await handleDavRequest(req, ctx());
    expect(res.status).toBe(405);
  });

  it("scoped token HEAD on root returns 405", async () => {
    const scopedTok = await issueTestToken(testEnv.db, {
      userId: USER_ID,
      paths: [{ path: "docs", access: "read" }],
    });
    const req = new Request("http://localhost/dav/", {
      method: "HEAD",
      headers: { Authorization: basicAuthHeader(scopedTok.rawToken) },
    });
    const res = await handleDavRequest(req, ctx());
    expect(res.status).toBe(405);
  });
});

describe("PUT error paths", () => {
  it("returns 400 for PUT to root", async () => {
    const res = await handleDavRequest(
      dav("PUT", "/", { body: "data" }),
      ctx(),
    );
    expect(res.status).toBe(400);
  });
});

describe("DELETE error paths", () => {
  it("returns 400 for DELETE root", async () => {
    const res = await handleDavRequest(dav("DELETE", "/"), ctx());
    expect(res.status).toBe(400);
  });
});

describe("MKCOL error paths", () => {
  it("returns 405 with Allow for MKCOL on scope root (always mapped)", async () => {
    const res = await handleDavRequest(dav("MKCOL", "/"), ctx());
    expect(res.status).toBe(405);
    const allow = res.headers.get("Allow") ?? "";
    expect(allow).toContain("PROPFIND");
    // RFC 4918 §9.3.1: MKCOL is only valid on unmapped URLs, so it must NOT
    // appear in the Allow set for an existing collection.
    expect(allow).not.toContain("MKCOL");
  });

  it("returns 405 with Allow for MKCOL on virtual root of a scoped token", async () => {
    const scopedTok = await issueTestToken(testEnv.db, {
      userId: USER_ID,
      paths: [{ path: "notes", access: "write" }],
    });
    const req = new Request("http://localhost/dav/", {
      method: "MKCOL",
      headers: { Authorization: basicAuthHeader(scopedTok.rawToken) },
    });
    const res = await handleDavRequest(req, ctx());
    expect(res.status).toBe(405);
    const allow = res.headers.get("Allow") ?? "";
    expect(allow).toContain("PROPFIND");
    expect(allow).not.toContain("MKCOL");
  });
});

describe("unsupported method", () => {
  it("returns 405 for unsupported method", async () => {
    const res = await handleDavRequest(dav("PATCH", "/test"), ctx());
    expect(res.status).toBe(405);
  });
});

describe("PUT + GET + HEAD", () => {
  it("PUT creates a new file and returns 201", async () => {
    const res = await handleDavRequest(
      dav("PUT", "/test.txt", {
        body: "Hello World",
        headers: { "Content-Type": "text/plain" },
      }),
      ctx(),
    );

    expect(res.status).toBe(201);
  });

  it("GET returns file content", async () => {
    await handleDavRequest(
      dav("PUT", "/test.txt", {
        body: "Hello World",
        headers: { "Content-Type": "text/plain" },
      }),
      ctx(),
    );

    const res = await handleDavRequest(dav("GET", "/test.txt"), ctx());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Hello World");
    expect(res.headers.get("Content-Type")).toBe("text/plain");
  });

  it("HEAD returns metadata without body", async () => {
    await handleDavRequest(
      dav("PUT", "/test.txt", {
        body: "Hello",
        headers: { "Content-Type": "text/plain" },
      }),
      ctx(),
    );

    const res = await handleDavRequest(dav("HEAD", "/test.txt"), ctx());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(res.headers.get("Content-Length")).toBe("5");
  });

  it("PUT overwrite returns 204 and updates bytes_used", async () => {
    await handleDavRequest(dav("PUT", "/test.txt", { body: "short" }), ctx());
    const res = await handleDavRequest(
      dav("PUT", "/test.txt", { body: "longer content here" }),
      ctx(),
    );

    expect(res.status).toBe(204);

    const user = await testEnv.db.queryOne<{ bytes_used: number }>(
      "SELECT bytes_used FROM user_storage WHERE user_id = $1",
      [USER_ID],
    );
    expect(user?.bytes_used).toBeGreaterThan(0);
  });
});

// ── ETag ────────────────────────────────────────────────────

describe("ETag", () => {
  it("GET returns ETag header", async () => {
    await handleDavRequest(dav("PUT", "/etag.txt", { body: "content" }), ctx());

    const res = await handleDavRequest(dav("GET", "/etag.txt"), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toMatch(/^"\d+"$/);
  });

  it("HEAD returns ETag header", async () => {
    await handleDavRequest(
      dav("PUT", "/etag-head.txt", { body: "content" }),
      ctx(),
    );

    const res = await handleDavRequest(dav("HEAD", "/etag-head.txt"), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toMatch(/^"\d+"$/);
  });

  it("PUT returns ETag header", async () => {
    const res = await handleDavRequest(
      dav("PUT", "/etag-put.txt", { body: "content" }),
      ctx(),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("ETag")).toMatch(/^"\d+"$/);
  });

  it("GET with matching If-None-Match returns 304", async () => {
    await handleDavRequest(
      dav("PUT", "/etag-304.txt", { body: "content" }),
      ctx(),
    );

    const getRes = await handleDavRequest(dav("GET", "/etag-304.txt"), ctx());
    const etag = getRes.headers.get("ETag");

    const conditionalRes = await handleDavRequest(
      dav("GET", "/etag-304.txt", {
        headers: { "If-None-Match": etag ?? "" },
      }),
      ctx(),
    );
    expect(conditionalRes.status).toBe(304);
  });

  it("HEAD with matching If-None-Match returns 304", async () => {
    await handleDavRequest(
      dav("PUT", "/etag-head-304.txt", { body: "content" }),
      ctx(),
    );

    const headRes = await handleDavRequest(
      dav("HEAD", "/etag-head-304.txt"),
      ctx(),
    );
    const etag = headRes.headers.get("ETag");

    const conditionalRes = await handleDavRequest(
      dav("HEAD", "/etag-head-304.txt", {
        headers: { "If-None-Match": etag ?? "" },
      }),
      ctx(),
    );
    expect(conditionalRes.status).toBe(304);
  });

  it("PUT with mismatched If-Match returns 412", async () => {
    await handleDavRequest(dav("PUT", "/etag-412.txt", { body: "v1" }), ctx());

    const res = await handleDavRequest(
      dav("PUT", "/etag-412.txt", {
        body: "v2",
        headers: { "If-Match": '"999"' },
      }),
      ctx(),
    );
    expect(res.status).toBe(412);
  });

  it("PUT with If-None-Match: * rejects if file exists", async () => {
    await handleDavRequest(dav("PUT", "/etag-star.txt", { body: "v1" }), ctx());

    const res = await handleDavRequest(
      dav("PUT", "/etag-star.txt", {
        body: "v2",
        headers: { "If-None-Match": "*" },
      }),
      ctx(),
    );
    expect(res.status).toBe(412);
  });

  it("PUT with If-Match returns 412 for non-existent resource", async () => {
    const res = await handleDavRequest(
      dav("PUT", "/no-such-file.txt", {
        body: "data",
        headers: { "If-Match": '"1"' },
      }),
      ctx(),
    );
    expect(res.status).toBe(412);
  });
});

// ── Range (RFC 9110 §14) ─────────────────────────────────────

describe("Range / Partial Content", () => {
  const BODY = "0123456789ABCDEFGHIJ"; // 20 bytes, easy slicing

  async function putBody(path = "/range.bin") {
    await handleDavRequest(
      dav("PUT", path, {
        body: BODY,
        headers: { "Content-Type": "application/octet-stream" },
      }),
      ctx(),
    );
  }

  it("GET without Range returns 200 + full body + Accept-Ranges: bytes", async () => {
    await putBody();
    const res = await handleDavRequest(dav("GET", "/range.bin"), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Length")).toBe(String(BODY.length));
    expect(await res.text()).toBe(BODY);
  });

  it("HEAD without Range returns 200 + Accept-Ranges: bytes", async () => {
    await putBody();
    const res = await handleDavRequest(dav("HEAD", "/range.bin"), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Length")).toBe(String(BODY.length));
  });

  it("GET with bytes=0-9 returns 206 + Content-Range + first 10 bytes", async () => {
    await putBody();
    const res = await handleDavRequest(
      dav("GET", "/range.bin", { headers: { Range: "bytes=0-9" } }),
      ctx(),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 0-9/${BODY.length}`);
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await res.text()).toBe(BODY.slice(0, 10));
  });

  it("GET with bytes=5-14 returns 206 + middle bytes", async () => {
    await putBody();
    const res = await handleDavRequest(
      dav("GET", "/range.bin", { headers: { Range: "bytes=5-14" } }),
      ctx(),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 5-14/${BODY.length}`);
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(await res.text()).toBe(BODY.slice(5, 15));
  });

  it("GET with bytes=10- (open-ended) returns 206 + tail", async () => {
    await putBody();
    const res = await handleDavRequest(
      dav("GET", "/range.bin", { headers: { Range: "bytes=10-" } }),
      ctx(),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 10-19/${BODY.length}`);
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(await res.text()).toBe(BODY.slice(10));
  });

  it("GET with bytes=-5 (suffix) returns 206 + last 5 bytes", async () => {
    await putBody();
    const res = await handleDavRequest(
      dav("GET", "/range.bin", { headers: { Range: "bytes=-5" } }),
      ctx(),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 15-19/${BODY.length}`);
    expect(res.headers.get("Content-Length")).toBe("5");
    expect(await res.text()).toBe(BODY.slice(-5));
  });

  it("GET with last-byte-pos > size clamps to last byte", async () => {
    await putBody();
    const res = await handleDavRequest(
      dav("GET", "/range.bin", { headers: { Range: "bytes=15-999" } }),
      ctx(),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 15-19/${BODY.length}`);
    expect(res.headers.get("Content-Length")).toBe("5");
    expect(await res.text()).toBe(BODY.slice(15));
  });

  it("GET with firstByte >= size returns 416 + Content-Range: bytes */size", async () => {
    await putBody();
    const res = await handleDavRequest(
      dav("GET", "/range.bin", { headers: { Range: "bytes=100-200" } }),
      ctx(),
    );
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe(`bytes */${BODY.length}`);
  });

  it("GET with bytes=N- when N >= size returns 416", async () => {
    await putBody();
    const res = await handleDavRequest(
      dav("GET", "/range.bin", { headers: { Range: "bytes=20-" } }),
      ctx(),
    );
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe(`bytes */${BODY.length}`);
  });

  it("GET with bytes=-0 (zero suffix) returns 416", async () => {
    await putBody();
    const res = await handleDavRequest(
      dav("GET", "/range.bin", { headers: { Range: "bytes=-0" } }),
      ctx(),
    );
    expect(res.status).toBe(416);
  });

  it("GET with malformed Range header is ignored, returns 200 full body", async () => {
    await putBody();
    const res = await handleDavRequest(
      dav("GET", "/range.bin", { headers: { Range: "bytes=abc" } }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe(String(BODY.length));
    expect(await res.text()).toBe(BODY);
  });

  it("GET with non-bytes unit is ignored, returns 200 full body", async () => {
    await putBody();
    const res = await handleDavRequest(
      dav("GET", "/range.bin", { headers: { Range: "chars=0-9" } }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(BODY);
  });

  it("GET with multi-range falls back to 200 full body (v1)", async () => {
    await putBody();
    const res = await handleDavRequest(
      dav("GET", "/range.bin", { headers: { Range: "bytes=0-4,10-14" } }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(BODY);
  });

  it("GET with If-Range matching ETag returns 206", async () => {
    await putBody();
    const head = await handleDavRequest(dav("HEAD", "/range.bin"), ctx());
    const etag = head.headers.get("ETag");
    expect(etag).not.toBeNull();
    const res = await handleDavRequest(
      dav("GET", "/range.bin", {
        headers: { Range: "bytes=0-9", "If-Range": etag ?? "" },
      }),
      ctx(),
    );
    expect(res.status).toBe(206);
    expect(await res.text()).toBe(BODY.slice(0, 10));
  });

  it("GET with If-Range NOT matching ETag returns 200 full body", async () => {
    await putBody();
    const res = await handleDavRequest(
      dav("GET", "/range.bin", {
        headers: { Range: "bytes=0-9", "If-Range": '"999999"' },
      }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe(String(BODY.length));
    expect(await res.text()).toBe(BODY);
  });
});

// ── DELETE ───────────────────────────────────────────────────

describe("DELETE", () => {
  it("removes file and decrements bytes_used", async () => {
    await handleDavRequest(
      dav("PUT", "/del.txt", { body: "to be deleted" }),
      ctx(),
    );

    const before = await testEnv.db.queryOne<{ bytes_used: number }>(
      "SELECT bytes_used FROM user_storage WHERE user_id = $1",
      [USER_ID],
    );

    const res = await handleDavRequest(dav("DELETE", "/del.txt"), ctx());
    expect(res.status).toBe(204);

    const after = await testEnv.db.queryOne<{ bytes_used: number }>(
      "SELECT bytes_used FROM user_storage WHERE user_id = $1",
      [USER_ID],
    );
    // Soft delete: bytes_used unchanged (trash counts toward quota)
    expect(after?.bytes_used).toBe(before?.bytes_used);
  });

  it("returns 404 for non-existent path", async () => {
    const res = await handleDavRequest(
      dav("DELETE", "/nonexistent.txt"),
      ctx(),
    );
    expect(res.status).toBe(404);
  });

  it("recursively deletes directories", async () => {
    await handleDavRequest(dav("MKCOL", "/folder"), ctx());
    await handleDavRequest(dav("PUT", "/folder/a.txt", { body: "a" }), ctx());
    await handleDavRequest(dav("PUT", "/folder/b.txt", { body: "b" }), ctx());

    const res = await handleDavRequest(dav("DELETE", "/folder"), ctx());
    expect(res.status).toBe(204);

    const propfind = await handleDavRequest(dav("PROPFIND", "/folder/"), ctx());
    expect(propfind.status).toBe(404);
  });
});

// ── MKCOL ───────────────────────────────────────────────────

describe("MKCOL", () => {
  it("creates a directory and returns 201", async () => {
    const res = await handleDavRequest(dav("MKCOL", "/photos"), ctx());
    expect(res.status).toBe(201);

    const propfind = await handleDavRequest(
      dav("PROPFIND", "/photos/", { headers: { Depth: "0" } }),
      ctx(),
    );
    expect(propfind.status).toBe(207);
  });

  it("returns 405 with Allow if directory already exists", async () => {
    await handleDavRequest(dav("MKCOL", "/dup"), ctx());
    const res = await handleDavRequest(dav("MKCOL", "/dup"), ctx());
    expect(res.status).toBe(405);
    const allow = res.headers.get("Allow") ?? "";
    expect(allow).toContain("PROPFIND");
    expect(allow).not.toContain("MKCOL");
  });

  it("returns 415 for MKCOL with body", async () => {
    const res = await handleDavRequest(
      dav("MKCOL", "/withbody", { body: "some content" }),
      ctx(),
    );
    expect(res.status).toBe(415);
  });
});

// ── LOCK / UNLOCK / PROPPATCH ────────────────────────────────

describe("LOCK", () => {
  it("returns 200 with XML body and Lock-Token header", async () => {
    const res = await handleDavRequest(dav("LOCK", "/lockme.txt"), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/xml");
    expect(res.headers.get("Lock-Token")).toMatch(/^<urn:uuid:.+>$/);

    const xml = await res.text();
    expect(xml).toContain("<D:activelock>");
    expect(xml).toContain("<D:write/>");
    expect(xml).toContain("<D:exclusive/>");
  });
});

describe("UNLOCK", () => {
  it("returns 204", async () => {
    const res = await handleDavRequest(
      dav("UNLOCK", "/test.txt", {
        headers: { "Lock-Token": "<urn:uuid:abc>" },
      }),
      ctx(),
    );
    expect(res.status).toBe(204);
  });
});

describe("PROPPATCH", () => {
  it("returns 207 multistatus", async () => {
    const res = await handleDavRequest(dav("PROPPATCH", "/test.txt"), ctx());
    expect(res.status).toBe(207);
    const xml = await res.text();
    expect(xml).toContain("200 OK");
  });
});

// ── COPY ────────────────────────────────────────────────────

describe("COPY", () => {
  it("returns 400 without Destination header", async () => {
    await handleDavRequest(dav("PUT", "/no-dest.txt", { body: "data" }), ctx());
    const res = await handleDavRequest(dav("COPY", "/no-dest.txt"), ctx());
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent source", async () => {
    const res = await handleDavRequest(
      dav("COPY", "/ghost.txt", {
        headers: { Destination: "http://localhost/dav/copy.txt" },
      }),
      ctx(),
    );
    expect(res.status).toBe(404);
  });

  it("duplicates a file to a new path", async () => {
    await handleDavRequest(
      dav("PUT", "/src.txt", { body: "source content" }),
      ctx(),
    );

    const res = await handleDavRequest(
      dav("COPY", "/src.txt", {
        headers: { Destination: "http://localhost/dav/dst.txt" },
      }),
      ctx(),
    );
    expect(res.status).toBe(201);

    const get = await handleDavRequest(dav("GET", "/dst.txt"), ctx());
    expect(await get.text()).toBe("source content");

    const srcGet = await handleDavRequest(dav("GET", "/src.txt"), ctx());
    expect(srcGet.status).toBe(200);
  });

  it("returns 412 when Overwrite: F and dest exists", async () => {
    await handleDavRequest(dav("PUT", "/a.txt", { body: "a" }), ctx());
    await handleDavRequest(dav("PUT", "/b.txt", { body: "b" }), ctx());

    const res = await handleDavRequest(
      dav("COPY", "/a.txt", {
        headers: {
          Destination: "http://localhost/dav/b.txt",
          Overwrite: "F",
        },
      }),
      ctx(),
    );
    expect(res.status).toBe(412);
  });

  it("copies a directory recursively", async () => {
    await handleDavRequest(dav("MKCOL", "/srcdir"), ctx());
    await handleDavRequest(
      dav("PUT", "/srcdir/a.txt", { body: "file a" }),
      ctx(),
    );
    await handleDavRequest(
      dav("PUT", "/srcdir/b.txt", { body: "file b" }),
      ctx(),
    );

    const res = await handleDavRequest(
      dav("COPY", "/srcdir", {
        headers: { Destination: "http://localhost/dav/dstdir" },
      }),
      ctx(),
    );
    expect(res.status).toBe(201);

    // Verify children exist at destination
    const getA = await handleDavRequest(dav("GET", "/dstdir/a.txt"), ctx());
    expect(getA.status).toBe(200);
    expect(await getA.text()).toBe("file a");

    const getB = await handleDavRequest(dav("GET", "/dstdir/b.txt"), ctx());
    expect(getB.status).toBe(200);
    expect(await getB.text()).toBe("file b");

    // Source still exists
    const srcPropfind = await handleDavRequest(
      dav("PROPFIND", "/srcdir/", { headers: { Depth: "0" } }),
      ctx(),
    );
    expect(srcPropfind.status).toBe(207);
  });

  it("rejects COPY into descendant of source with 409", async () => {
    await handleDavRequest(dav("MKCOL", "/parent"), ctx());
    await handleDavRequest(
      dav("PUT", "/parent/file.txt", { body: "data" }),
      ctx(),
    );

    const res = await handleDavRequest(
      dav("COPY", "/parent", {
        headers: { Destination: "http://localhost/dav/parent/child" },
      }),
      ctx(),
    );
    expect(res.status).toBe(409);
  });

  it("Depth: 0 copies directory without children", async () => {
    await handleDavRequest(dav("MKCOL", "/shallow-src"), ctx());
    await handleDavRequest(
      dav("PUT", "/shallow-src/child.txt", { body: "child" }),
      ctx(),
    );

    const res = await handleDavRequest(
      dav("COPY", "/shallow-src", {
        headers: {
          Destination: "http://localhost/dav/shallow-dst",
          Depth: "0",
        },
      }),
      ctx(),
    );
    expect(res.status).toBe(201);

    // Destination directory exists
    const propfind = await handleDavRequest(
      dav("PROPFIND", "/shallow-dst/", { headers: { Depth: "0" } }),
      ctx(),
    );
    expect(propfind.status).toBe(207);

    // But children are NOT copied
    const childGet = await handleDavRequest(
      dav("GET", "/shallow-dst/child.txt"),
      ctx(),
    );
    expect(childGet.status).toBe(404);
  });
});

// ── MOVE ────────────────────────────────────────────────────

describe("MOVE", () => {
  it("returns 400 without Destination header", async () => {
    await handleDavRequest(
      dav("PUT", "/no-dest-move.txt", { body: "data" }),
      ctx(),
    );
    const res = await handleDavRequest(dav("MOVE", "/no-dest-move.txt"), ctx());
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent source", async () => {
    const res = await handleDavRequest(
      dav("MOVE", "/ghost.txt", {
        headers: { Destination: "http://localhost/dav/moved.txt" },
      }),
      ctx(),
    );
    expect(res.status).toBe(404);
  });

  it("renames a file without losing content", async () => {
    await handleDavRequest(dav("PUT", "/old.txt", { body: "move me" }), ctx());

    const res = await handleDavRequest(
      dav("MOVE", "/old.txt", {
        headers: { Destination: "http://localhost/dav/new.txt" },
      }),
      ctx(),
    );
    expect(res.status).toBe(201);

    const oldGet = await handleDavRequest(dav("GET", "/old.txt"), ctx());
    expect(oldGet.status).toBe(404);

    const newGet = await handleDavRequest(dav("GET", "/new.txt"), ctx());
    expect(newGet.status).toBe(200);
    expect(await newGet.text()).toBe("move me");
  });
});

// ── Permission scoping ──────────────────────────────────────

describe("token scope", () => {
  it("read-only token is rejected for PUT with 403", async () => {
    const readUser = await createTestUser(testEnv.db, {
      id: "user_readonly",
    });
    const readTok = await issueTestToken(testEnv.db, {
      userId: readUser.id,
      paths: [{ path: "", access: "read" }],
    });

    const putReq = new Request("http://localhost/dav/newfile.txt", {
      method: "PUT",
      headers: { Authorization: basicAuthHeader(readTok.rawToken) },
      body: "forbidden",
    });
    const putRes = await handleDavRequest(putReq, ctx());
    expect(putRes.status).toBe(403);
  });

  it("read-only token can PROPFIND root", async () => {
    const readUser = await createTestUser(testEnv.db, {
      id: "user_readonly2",
    });
    const readTok = await issueTestToken(testEnv.db, {
      userId: readUser.id,
      paths: [{ path: "", access: "read" }],
    });

    const propfindReq = new Request("http://localhost/dav/", {
      method: "PROPFIND",
      headers: {
        Authorization: basicAuthHeader(readTok.rawToken),
        Depth: "0",
      },
    });
    const res = await handleDavRequest(propfindReq, ctx());
    expect(res.status).toBe(207);
  });
});

// ── MOVE/COPY destination permission ────────────────────────

describe("MOVE/COPY destination permission", () => {
  it("COPY rejects when read-only token tries to copy to root", async () => {
    await handleDavRequest(dav("PUT", "/src.txt", { body: "copy me" }), ctx());

    const roTok = await issueTestToken(testEnv.db, {
      userId: USER_ID,
      paths: [{ path: "", access: "read" }],
    });

    const copyReq = new Request("http://localhost/dav/src.txt", {
      method: "COPY",
      headers: {
        Authorization: basicAuthHeader(roTok.rawToken),
        Destination: "http://localhost/dav/dst.txt",
      },
    });
    const res = await handleDavRequest(copyReq, ctx());
    expect(res.status).toBe(403);
  });

  it("MOVE rejects when read-only token tries to move file", async () => {
    await handleDavRequest(
      dav("PUT", "/moveme.txt", { body: "move me" }),
      ctx(),
    );

    const roTok = await issueTestToken(testEnv.db, {
      userId: USER_ID,
      paths: [{ path: "", access: "read" }],
    });

    const moveReq = new Request("http://localhost/dav/moveme.txt", {
      method: "MOVE",
      headers: {
        Authorization: basicAuthHeader(roTok.rawToken),
        Destination: "http://localhost/dav/moved.txt",
      },
    });
    const res = await handleDavRequest(moveReq, ctx());
    expect(res.status).toBe(403);
  });
});

// ── MOVE with Overwrite header ──────────────────────────────

describe("MOVE with Overwrite header", () => {
  it("Overwrite: T replaces existing destination", async () => {
    await handleDavRequest(
      dav("PUT", "/mv-src.txt", { body: "source data" }),
      ctx(),
    );
    await handleDavRequest(
      dav("PUT", "/mv-dst.txt", { body: "old destination" }),
      ctx(),
    );

    const res = await handleDavRequest(
      dav("MOVE", "/mv-src.txt", {
        headers: {
          Destination: "http://localhost/dav/mv-dst.txt",
          Overwrite: "T",
        },
      }),
      ctx(),
    );
    expect(res.status).toBe(204);

    const srcGet = await handleDavRequest(dav("GET", "/mv-src.txt"), ctx());
    expect(srcGet.status).toBe(404);

    const dstGet = await handleDavRequest(dav("GET", "/mv-dst.txt"), ctx());
    expect(dstGet.status).toBe(200);
    expect(await dstGet.text()).toBe("source data");
  });

  it("Overwrite: T returns 409 for dir→dir (no implicit non-atomic replace)", async () => {
    await handleDavRequest(dav("MKCOL", "/mv-srcdir"), ctx());
    await handleDavRequest(
      dav("PUT", "/mv-srcdir/inside.txt", { body: "src content" }),
      ctx(),
    );
    await handleDavRequest(dav("MKCOL", "/mv-dstdir"), ctx());
    await handleDavRequest(
      dav("PUT", "/mv-dstdir/keep.txt", { body: "dst content" }),
      ctx(),
    );

    const res = await handleDavRequest(
      dav("MOVE", "/mv-srcdir", {
        headers: {
          Destination: "http://localhost/dav/mv-dstdir",
          Overwrite: "T",
        },
      }),
      ctx(),
    );
    expect(res.status).toBe(409);

    // Both still intact
    const srcGet = await handleDavRequest(
      dav("GET", "/mv-srcdir/inside.txt"),
      ctx(),
    );
    expect(srcGet.status).toBe(200);
    const dstGet = await handleDavRequest(
      dav("GET", "/mv-dstdir/keep.txt"),
      ctx(),
    );
    expect(dstGet.status).toBe(200);
  });

  it("Overwrite: T returns 409 for file→dir (type mismatch)", async () => {
    await handleDavRequest(dav("PUT", "/mv-fsrc.txt", { body: "src" }), ctx());
    await handleDavRequest(dav("MKCOL", "/mv-fdst"), ctx());
    await handleDavRequest(
      dav("PUT", "/mv-fdst/inner.txt", { body: "dst inner" }),
      ctx(),
    );

    const res = await handleDavRequest(
      dav("MOVE", "/mv-fsrc.txt", {
        headers: {
          Destination: "http://localhost/dav/mv-fdst",
          Overwrite: "T",
        },
      }),
      ctx(),
    );
    expect(res.status).toBe(409);

    const srcGet = await handleDavRequest(dav("GET", "/mv-fsrc.txt"), ctx());
    expect(srcGet.status).toBe(200);
    const dstGet = await handleDavRequest(
      dav("GET", "/mv-fdst/inner.txt"),
      ctx(),
    );
    expect(dstGet.status).toBe(200);
  });

  it("Overwrite: T returns 409 for dir→file (type mismatch)", async () => {
    await handleDavRequest(dav("MKCOL", "/mv-dsrc"), ctx());
    await handleDavRequest(
      dav("PUT", "/mv-dsrc/x.txt", { body: "src inner" }),
      ctx(),
    );
    await handleDavRequest(
      dav("PUT", "/mv-ddst.txt", { body: "dst file" }),
      ctx(),
    );

    const res = await handleDavRequest(
      dav("MOVE", "/mv-dsrc", {
        headers: {
          Destination: "http://localhost/dav/mv-ddst.txt",
          Overwrite: "T",
        },
      }),
      ctx(),
    );
    expect(res.status).toBe(409);

    const srcGet = await handleDavRequest(dav("GET", "/mv-dsrc/x.txt"), ctx());
    expect(srcGet.status).toBe(200);
    const dstGet = await handleDavRequest(dav("GET", "/mv-ddst.txt"), ctx());
    expect(dstGet.status).toBe(200);
  });

  it("Overwrite: F returns 412 when destination exists", async () => {
    await handleDavRequest(
      dav("PUT", "/mv-src2.txt", { body: "source" }),
      ctx(),
    );
    await handleDavRequest(
      dav("PUT", "/mv-dst2.txt", { body: "existing" }),
      ctx(),
    );

    const res = await handleDavRequest(
      dav("MOVE", "/mv-src2.txt", {
        headers: {
          Destination: "http://localhost/dav/mv-dst2.txt",
          Overwrite: "F",
        },
      }),
      ctx(),
    );
    expect(res.status).toBe(412);

    const srcGet = await handleDavRequest(dav("GET", "/mv-src2.txt"), ctx());
    expect(srcGet.status).toBe(200);

    const dstGet = await handleDavRequest(dav("GET", "/mv-dst2.txt"), ctx());
    expect(await dstGet.text()).toBe("existing");
  });
});

// ── Storage limit ──────────────────────────────────────────

describe("PUT storage limit", () => {
  it("returns 507 when storage limit exceeded", async () => {
    const limitUser = await createTestUser(testEnv.db, {
      id: "user_limit_test",
      limits: FINITE_TEST_LIMITS,
    });
    const limitTok = await issueTestToken(testEnv.db, {
      userId: limitUser.id,
    });

    const freeLimit = 1 * 1024 * 1024 * 1024;
    await testEnv.db.execute(
      "UPDATE user_storage SET bytes_used = $1 WHERE user_id = $2",
      [freeLimit - 1, limitUser.id],
    );

    const putReq = new Request("http://localhost/dav/big.txt", {
      method: "PUT",
      headers: { Authorization: basicAuthHeader(limitTok.rawToken) },
      body: "x".repeat(100),
    });
    const res = await handleDavRequest(putReq, ctx());
    expect(res.status).toBe(507);
  });
});
