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
import { action as filesAction } from "../api.files.$";
import { action } from "../api.files-mkdir";

let testEnv: TestEnv;
let token: string;
const USER_ID = "user_mkdir_test";

function ctx() {
  return testLoadContext(testEnv);
}

function mkdirReq(body: { path?: string }): Request {
  return new Request("http://localhost/api/v1/files-mkdir", {
    method: "POST",
    headers: {
      Authorization: bearerHeader(token),
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
  const user = await createTestUser(testEnv.db, { id: USER_ID });
  const tok = await issueTestToken(testEnv.db, { userId: user.id });
  token = tok.rawToken;
});

describe("POST /api/v1/files-mkdir", () => {
  it("creates a directory and returns 201", async () => {
    const res = await action({
      request: mkdirReq({ path: "newdir" }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBe("newdir");
    expect(body.type).toBe("directory");
  });

  it("returns 200 idempotent when directory already exists", async () => {
    const first = await action({
      request: mkdirReq({ path: "twice" }),
      context: ctx(),
      params: {},
    });
    expect(first.status).toBe(201);

    const second = await action({
      request: mkdirReq({ path: "twice" }),
      context: ctx(),
      params: {},
    });
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.type).toBe("directory");
  });

  it("returns 409 when path already exists as a file", async () => {
    await filesAction({
      request: new Request("http://localhost/api/v1/files/existing.txt", {
        method: "PUT",
        headers: {
          Authorization: bearerHeader(token),
          "Content-Type": "text/plain",
        },
        body: "data",
      }),
      context: ctx(),
      params: { "*": "existing.txt" },
    });

    const res = await action({
      request: mkdirReq({ path: "existing.txt" }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(409);
  });

  it("returns 400 for missing path", async () => {
    const res = await action({
      request: mkdirReq({}),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(400);
  });

  it("returns 401 without auth", async () => {
    const res = await action({
      request: new Request("http://localhost/api/v1/files-mkdir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "x" }),
      }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(401);
  });

  it("returns 405 for non-POST method", async () => {
    const res = await action({
      request: new Request("http://localhost/api/v1/files-mkdir", {
        method: "PUT",
        headers: { Authorization: bearerHeader(token) },
      }),
      context: ctx(),
      params: {},
    });
    expect(res.status).toBe(405);
  });
});
