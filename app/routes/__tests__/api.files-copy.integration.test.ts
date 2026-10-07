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
import { action } from "../api.files-copy";

let testEnv: TestEnv;
let token: string;
const USER_ID = "user_copy_test";

function ctx() {
  return testLoadContext(testEnv);
}

function copyReq(body: {
  from?: string;
  to?: string;
  overwrite?: boolean;
}): Request {
  return new Request("http://localhost/api/v1/files-copy", {
    method: "POST",
    headers: {
      Authorization: bearerHeader(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function putFile(path: string, content = "data"): Promise<Response> {
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

async function getFileBody(path: string): Promise<string> {
  const res = await filesLoader({
    request: new Request(`http://localhost/api/v1/files/${path}`, {
      method: "GET",
      headers: { Authorization: bearerHeader(token) },
    }),
    context: ctx(),
    params: { "*": path },
  });
  return await res.text();
}

async function headFile(path: string): Promise<Response> {
  return filesLoader({
    request: new Request(`http://localhost/api/v1/files/${path}`, {
      method: "HEAD",
      headers: { Authorization: bearerHeader(token) },
    }),
    context: ctx(),
    params: { "*": path },
  });
}

async function listDir(path: string): Promise<Array<{ name: string }>> {
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

beforeAll(async () => {
  testEnv = await createTestEnv();
});

afterAll(async () => {
  await disposeTestEnv(testEnv);
});

beforeEach(async () => {
  await cleanTestEnv(testEnv);
  const user = await createTestUser(testEnv.db, { id: USER_ID });
  const tok = await issueTestToken(testEnv.db, { userId: user.id });
  token = tok.rawToken;
});

describe("POST /api/v1/files-copy", () => {
  it("copies a file and returns 201", async () => {
    await putFile("src.txt", "hello");

    const res = await action({
      request: copyReq({ from: "src.txt", to: "dst.txt" }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    // response shape is discriminated by `type`.
    expect(body.type).toBe("file");
    expect(body.id).toBeDefined();
    expect(body.size).toBe(5);
  });

  it("returns 409 when destination exists and overwrite is false", async () => {
    await putFile("src.txt", "src");
    await putFile("dst.txt", "dst");

    const res = await action({
      request: copyReq({ from: "src.txt", to: "dst.txt" }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(409);
  });

  it("returns 401 without auth", async () => {
    const res = await action({
      request: new Request("http://localhost/api/v1/files-copy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "a", to: "b" }),
      }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 for missing from/to", async () => {
    const res = await action({
      request: copyReq({ from: "src.txt" }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(400);
  });

  it("returns 405 for non-POST method", async () => {
    const res = await action({
      request: new Request("http://localhost/api/v1/files-copy", {
        method: "PUT",
        headers: { Authorization: bearerHeader(token) },
      }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(405);
  });
});

describe("directory copy", () => {
  it("copies a directory subtree", async () => {
    await mkdir("src");
    await mkdir("src/sub");
    await putFile("src/a.txt", "aaa");
    await putFile("src/sub/b.txt", "bbbb");

    const res = await action({
      request: copyReq({ from: "src", to: "dst" }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.type).toBe("directory");
    expect(Array.isArray(body.entries)).toBe(true);

    // Both files end up at the destination paths with original bytes.
    expect(await getFileBody("dst/a.txt")).toBe("aaa");
    expect(await getFileBody("dst/sub/b.txt")).toBe("bbbb");

    // Each entry carries the discriminated kind.
    const kinds = body.entries.map((e: { kind: string }) => e.kind);
    expect(kinds).toContain("file");
    expect(kinds).toContain("directory");
  });

  it("returns 409 when destination directory exists and overwrite=false", async () => {
    await mkdir("src");
    await putFile("src/a.txt", "src-a");
    await mkdir("dst");

    const res = await action({
      request: copyReq({ from: "src", to: "dst" }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(409);
  });

  it("history-preserving overwrite: existing destination file keeps node identity, gains a new revision", async () => {
    // Seed src and dst with same logical layout but different bytes at the
    // overlapping path. Capture dst's node id pre-copy.
    await mkdir("src");
    await putFile("src/file.txt", "src-bytes");
    await mkdir("dst");
    await putFile("dst/file.txt", "dst-bytes");

    const dstStatBefore = await headFile("dst/file.txt");
    const etagBefore = dstStatBefore.headers.get("ETag");

    const res = await action({
      request: copyReq({ from: "src", to: "dst", overwrite: true }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.type).toBe("directory");

    // Destination file now has src bytes, and was returned as `existed:true`
    // (history-preserving: same node, new revision).
    expect(await getFileBody("dst/file.txt")).toBe("src-bytes");
    const fileEntry = body.entries.find(
      (e: { kind: string; dest_path: string }) =>
        e.kind === "file" && e.dest_path === "/dst/file.txt",
    );
    expect(fileEntry).toBeDefined();
    expect(fileEntry.existed).toBe(true);

    // ETag must differ — a new revision was committed on the existing node.
    const dstStatAfter = await headFile("dst/file.txt");
    expect(dstStatAfter.headers.get("ETag")).not.toBe(etagBefore);
  });

  it("returns 409 with partial entries when mid-walk hits a conflict", async () => {
    // Setup src with two children. Pre-seed dst with the *second* child as
    // a directory so the file-write hits a type_mismatch mid-walk. The
    // first child's copy will have succeeded by then.
    await mkdir("src");
    await putFile("src/a.txt", "aaa");
    await putFile("src/b.txt", "bbb");
    await mkdir("dst");
    // Pre-existing collision: dst/b.txt is a directory, src/b.txt is a file.
    await mkdir("dst/b.txt");

    const res = await action({
      request: copyReq({ from: "src", to: "dst", overwrite: true }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    // Non-atomic: the response carries the already-copied entries.
    expect(body.error.partial).toBe(true);
    expect(Array.isArray(body.entries)).toBe(true);
    // a.txt should have been copied before the failure.
    const okFile = body.entries.find(
      (e: { kind: string; dest_path: string }) =>
        e.kind === "file" && e.dest_path === "/dst/a.txt",
    );
    expect(okFile).toBeDefined();
    expect(await getFileBody("dst/a.txt")).toBe("aaa");

    // Server state is consistent: dst/a.txt is the new revision, dst/b.txt
    // is still the pre-existing directory (no orphan node).
    const list = await listDir("dst/");
    const names = list.map((i) => i.name);
    expect(names).toContain("a.txt");
    expect(names).toContain("b.txt");
  });
});
