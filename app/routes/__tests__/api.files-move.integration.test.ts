// @ts-nocheck
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
import { action as filesAction, loader as filesLoader } from "../api.files.$";
import { action } from "../api.files-move";

let testEnv: TestEnv;
let token: string;
const USER_ID = "user_moves_test";

function ctx() {
  return testLoadContext(testEnv);
}

function moveReq(body: {
  from?: string;
  to?: string;
  overwrite?: boolean;
}): Request {
  return new Request("http://localhost/api/v1/files-move", {
    method: "POST",
    headers: {
      Authorization: bearerHeader(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function mkdir(path: string): Promise<Response> {
  return filesAction({
    request: new Request(`http://localhost/api/v1/files/${path}/`, {
      method: "PUT",
      headers: { Authorization: bearerHeader(token) },
      body: "",
    }),
    context: ctx(),
    params: { "*": `${path}/` },
  });
}

function putFile(path: string, content = "data"): Promise<Response> {
  return filesAction({
    request: new Request(`http://localhost/api/v1/files/${path}`, {
      method: "PUT",
      headers: {
        Authorization: bearerHeader(token),
        "Content-Type": "text/plain",
      },
      body: content,
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
  });
  const tok = await issueTestToken(testEnv.db, { userId: user.id });
  token = tok.rawToken;
});

describe("basic move", () => {
  it("renames a file and returns 200 with node id", async () => {
    await putFile("a.txt");

    const res = await action({
      request: moveReq({ from: "a.txt", to: "b.txt" }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.content_version).toEqual(expect.any(Number));
  });

  it("moves a file into a subdirectory", async () => {
    await putFile("root.txt");
    await filesAction({
      request: new Request("http://localhost/api/v1/files/subdir/", {
        method: "PUT",
        headers: { Authorization: bearerHeader(token) },
        body: "",
      }),
      context: ctx(),
      params: { "*": "subdir/" },
    });

    const res = await action({
      request: moveReq({ from: "root.txt", to: "subdir/root.txt" }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(200);
  });
});

describe("conflict", () => {
  it("returns 412 when destination exists and overwrite is unset (default false)", async () => {
    // align with WebDAV MOVE Overwrite:T semantics. Without
    // overwrite, a collision is a precondition failure (the caller must
    // explicitly opt into replacement).
    await putFile("src.txt", "source");
    await putFile("dst.txt", "destination");

    const res = await action({
      request: moveReq({ from: "src.txt", to: "dst.txt" }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(412);
  });

  it("returns 412 when destination exists and overwrite=false explicitly", async () => {
    await putFile("src.txt", "source");
    await putFile("dst.txt", "destination");

    const res = await action({
      request: moveReq({ from: "src.txt", to: "dst.txt", overwrite: false }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(412);
  });
});

describe("overwrite", () => {
  async function listDirItems(path: string): Promise<Array<{ name: string }>> {
    const res = await filesLoader({
      request: new Request(`http://localhost/api/v1/files/${path}`, {
        method: "GET",
        headers: { Authorization: bearerHeader(token) },
      }),
      context: ctx(),
      params: { "*": path },
    });
    const j = await res.json();
    return j.items ?? [];
  }

  it("replaces destination file when overwrite=true (file→file)", async () => {
    await putFile("src.txt", "source-bytes");
    await putFile("dst.txt", "destination-bytes");

    const res = await action({
      request: moveReq({ from: "src.txt", to: "dst.txt", overwrite: true }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overwritten).toBe(true);
    expect(body.id).toBeDefined();
    expect(body.content_version).toBeGreaterThan(0);

    // The source must be gone (moved into trash) and the destination's
    // node identity must be preserved (its bytes are now src's bytes).
    const items = await listDirItems("");
    const names = items.map((i) => i.name);
    expect(names).toContain("dst.txt");
    expect(names).not.toContain("src.txt");
  });

  it("returns 409 when overwrite=true but destination is a directory", async () => {
    await putFile("src.txt", "source");
    await mkdir("dst-dir");

    const res = await action({
      request: moveReq({
        from: "src.txt",
        to: "dst-dir",
        overwrite: true,
      }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(409);
  });
});

describe("cycle", () => {
  it("returns 409 when moving a directory into its own descendant", async () => {
    // descendant move surfaces as cycle from FileService, which
    // the REST layer maps to 409.
    await mkdir("outer");
    await mkdir("outer/inner");

    const res = await action({
      request: moveReq({ from: "outer", to: "outer/inner/outer" }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(409);
  });
});

describe("errors", () => {
  it("returns 404 when source does not exist", async () => {
    const res = await action({
      request: moveReq({ from: "nonexistent.txt", to: "dst.txt" }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when from/to is missing", async () => {
    await putFile("a.txt");

    const res = await action({
      request: moveReq({ from: "a.txt" }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(400);

    const res2 = await action({
      request: moveReq({ to: "b.txt" }),
      context: ctx(),
      params: {},
    });
    expect(res2.status).toBe(400);
  });

  it("returns 400 for malformed JSON body", async () => {
    const res = await action({
      request: new Request("http://localhost/api/v1/files-move", {
        method: "POST",
        headers: {
          Authorization: bearerHeader(token),
          "Content-Type": "application/json",
        },
        body: "not json",
      }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(400);
  });

  it("returns 401 without auth", async () => {
    const res = await action({
      request: new Request("http://localhost/api/v1/files-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "a.txt", to: "b.txt" }),
      }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(401);
  });

  it("returns 405 for non-POST method", async () => {
    const res = await action({
      request: new Request("http://localhost/api/v1/files-move", {
        method: "PUT",
        headers: {
          Authorization: bearerHeader(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from: "a.txt", to: "b.txt" }),
      }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(405);
  });
});

describe("token scope", () => {
  it("read-only token cannot move", async () => {
    await putFile("scoped.txt");

    const roTok = await issueTestToken(testEnv.db, {
      userId: USER_ID,
      paths: [{ path: "", access: "read" }],
    });

    const res = await action({
      request: new Request("http://localhost/api/v1/files-move", {
        method: "POST",
        headers: {
          Authorization: bearerHeader(roTok.rawToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from: "scoped.txt", to: "moved.txt" }),
      }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(403);
  });
});
