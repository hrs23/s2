// @ts-nocheck
// @vitest-environment node
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
import { action as filesAction } from "../api.files.$";
import {
  action as trashAction,
  loader as trashLoader,
} from "../internal.trash";
import { action as purgeAction } from "../internal.trash.$id";
import { action as restoreAction } from "../internal.trash.$id.restore";

let testEnv: TestEnv;
let cookie: string;
const USER_ID = "user_trash_test";

function ctx() {
  return testLoadContext(testEnv);
}

function req(
  method: string,
  url: string,
  opts: { body?: BodyInit; headers?: Record<string, string> } = {},
): Request {
  // `new Request` with a plain object strips Cookie headers (browser spec).
  // Use a Headers instance to pass them through.
  const h = new Headers();
  h.set("Cookie", cookie);
  for (const [k, v] of Object.entries(opts.headers ?? {})) h.set(k, v);
  return new Request(`http://localhost${url}`, {
    method,
    headers: h,
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

async function deleteFile(path: string) {
  return filesAction({
    request: req("DELETE", `/api/v1/files/${path}`),
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
  await createTestUser(testEnv.db, { id: USER_ID });
  cookie = await sessionCookieHeader(USER_ID, testEnv.env);
});

// ── GET /internal/trash ─────────────────────────────────────────

describe("GET /internal/trash", () => {
  it("returns 401 without auth", async () => {
    const r = new Request("http://localhost/internal/trash", {
      method: "GET",
    });
    const res = await trashLoader({ request: r, context: ctx(), params: {} });
    expect(res.status).toBe(401);
  });

  it("returns empty items when nothing is deleted", async () => {
    const res = await trashLoader({
      request: req("GET", "/internal/trash"),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
  });

  it("lists deleted files", async () => {
    await uploadFile("hello.txt", "Hello");
    await deleteFile("hello.txt");

    const res = await trashLoader({
      request: req("GET", "/internal/trash"),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].name).toBe("hello.txt");
    expect(body.items[0].type).toBe("file");
    expect(body.items[0].deleted_at).toBeTruthy();
  });
});

// ── POST /internal/trash/:id/restore ────────────────────────────

describe("POST /internal/trash/:id/restore", () => {
  it("returns 401 without auth", async () => {
    const r = new Request("http://localhost/internal/trash/xxx/restore", {
      method: "POST",
    });
    const res = await restoreAction({
      request: r,
      context: ctx(),
      params: { id: "xxx" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-existent node", async () => {
    const res = await restoreAction({
      request: req("POST", "/internal/trash/nonexistent/restore"),
      context: ctx(),
      params: { id: "nonexistent" },
    });
    expect(res.status).toBe(404);
  });

  it("restores a deleted file", async () => {
    // Upload, delete, then get the trash item ID
    await uploadFile("restore-me.txt", "content");
    await deleteFile("restore-me.txt");

    const trashRes = await trashLoader({
      request: req("GET", "/internal/trash"),
      context: ctx(),
      params: {},
    });
    const { items } = await trashRes.json();
    expect(items).toHaveLength(1);
    const nodeId = items[0].id;

    // Restore
    const res = await restoreAction({
      request: req("POST", `/internal/trash/${nodeId}/restore`),
      context: ctx(),
      params: { id: nodeId },
    });
    expect(res.status).toBe(200);

    // Trash should be empty now
    const trashRes2 = await trashLoader({
      request: req("GET", "/internal/trash"),
      context: ctx(),
      params: {},
    });
    const body2 = await trashRes2.json();
    expect(body2.items).toHaveLength(0);
  });

  it("returns 409 on name conflict", async () => {
    // Upload file, delete it, upload a new file with same name
    await uploadFile("conflict.txt", "original");
    await deleteFile("conflict.txt");

    const trashRes = await trashLoader({
      request: req("GET", "/internal/trash"),
      context: ctx(),
      params: {},
    });
    const { items } = await trashRes.json();
    const nodeId = items[0].id;

    // Upload new file with same name
    await uploadFile("conflict.txt", "new content");

    // Try to restore — should conflict
    const res = await restoreAction({
      request: req("POST", `/internal/trash/${nodeId}/restore`),
      context: ctx(),
      params: { id: nodeId },
    });
    expect(res.status).toBe(409);
  });

  it("returns 409 when parent folder is in trash", async () => {
    // Create folder with file, delete the folder (both go to trash)
    await uploadFile("parent-dir/child.txt", "content");
    await deleteFile("parent-dir");

    // Get the child node ID from DB (listTrash only shows top-level)
    const nodes = await testEnv.db.query<{ id: string; name: string }>(
      "SELECT id, name FROM file_nodes WHERE user_id = $1 AND deleted_at IS NOT NULL",
      [USER_ID],
    );
    const childNode = nodes.find((n) => n.name === "child.txt");
    expect(childNode).toBeDefined();

    // Try to restore child directly — should fail
    const res = await restoreAction({
      request: req("POST", `/internal/trash/${childNode?.id}/restore`),
      context: ctx(),
      params: { id: childNode?.id },
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toContain("Parent folder is in trash");
  });

  it("restores child when parent folder is restored first", async () => {
    // Create folder with file, delete the folder
    await uploadFile("restore-parent/file.txt", "content");
    await deleteFile("restore-parent");

    // Get top-level trash item (the folder)
    const trashRes = await trashLoader({
      request: req("GET", "/internal/trash"),
      context: ctx(),
      params: {},
    });
    const { items } = await trashRes.json();
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("restore-parent");

    // Restore the folder — should restore child too
    const res = await restoreAction({
      request: req("POST", `/internal/trash/${items[0].id}/restore`),
      context: ctx(),
      params: { id: items[0].id },
    });
    expect(res.status).toBe(200);

    // Both folder and child should be live now
    const trashRes2 = await trashLoader({
      request: req("GET", "/internal/trash"),
      context: ctx(),
      params: {},
    });
    const body2 = await trashRes2.json();
    expect(body2.items).toHaveLength(0);
  });

  it("returns 405 for non-POST methods", async () => {
    const res = await restoreAction({
      request: req("GET", "/internal/trash/xxx/restore"),
      context: ctx(),
      params: { id: "xxx" },
    });
    expect(res.status).toBe(405);
  });
});

// ── DELETE /internal/trash/:id ──────────────────────────────────
describe("DELETE /internal/trash/:id", () => {
  it("returns 401 without auth", async () => {
    const r = new Request("http://localhost/internal/trash/xxx", {
      method: "DELETE",
    });
    const res = await purgeAction({
      request: r,
      context: ctx(),
      params: { id: "xxx" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-existent node", async () => {
    const res = await purgeAction({
      request: req("DELETE", "/internal/trash/nonexistent"),
      context: ctx(),
      params: { id: "nonexistent" },
    });
    expect(res.status).toBe(404);
  });

  it("permanently deletes a trash item", async () => {
    await uploadFile("purge-me.txt", "content");
    await deleteFile("purge-me.txt");

    const trashRes = await trashLoader({
      request: req("GET", "/internal/trash"),
      context: ctx(),
      params: {},
    });
    const { items } = await trashRes.json();
    expect(items).toHaveLength(1);
    const nodeId = items[0].id;

    const res = await purgeAction({
      request: req("DELETE", `/internal/trash/${nodeId}`),
      context: ctx(),
      params: { id: nodeId },
    });
    expect(res.status).toBe(204);

    // Trash should be empty
    const trashRes2 = await trashLoader({
      request: req("GET", "/internal/trash"),
      context: ctx(),
      params: {},
    });
    const body2 = await trashRes2.json();
    expect(body2.items).toHaveLength(0);
  });

  it("returns 405 for non-DELETE methods", async () => {
    const res = await purgeAction({
      request: req("GET", "/internal/trash/xxx"),
      context: ctx(),
      params: { id: "xxx" },
    });
    expect(res.status).toBe(405);
  });
});

// ── DELETE /internal/trash ──────────────────────────────────────
describe("DELETE /internal/trash", () => {
  it("returns 401 without auth", async () => {
    const r = new Request("http://localhost/internal/trash", {
      method: "DELETE",
    });
    const res = await trashAction({ request: r, context: ctx(), params: {} });
    expect(res.status).toBe(401);
  });

  it("permanently deletes all trash items", async () => {
    await uploadFile("file-a.txt", "a");
    await uploadFile("file-b.txt", "b");
    await deleteFile("file-a.txt");
    await deleteFile("file-b.txt");

    const trashRes = await trashLoader({
      request: req("GET", "/internal/trash"),
      context: ctx(),
      params: {},
    });
    const { items } = await trashRes.json();
    expect(items).toHaveLength(2);

    const res = await trashAction({
      request: req("DELETE", "/internal/trash"),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(204);

    // Trash should be empty
    const trashRes2 = await trashLoader({
      request: req("GET", "/internal/trash"),
      context: ctx(),
      params: {},
    });
    const body2 = await trashRes2.json();
    expect(body2.items).toHaveLength(0);
  });

  it("returns 405 for non-DELETE methods", async () => {
    const res = await trashAction({
      request: req("POST", "/internal/trash"),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(405);
  });
});
