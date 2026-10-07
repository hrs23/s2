// @ts-nocheck
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CHUNK_SIZE } from "~/lib/storage/chunked.server";
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
import { action } from "../api.uploads.$id.$chunk";

let testEnv: TestEnv;
let token: string;

beforeAll(async () => {
  testEnv = await createTestEnv();
});

afterAll(async () => {
  await disposeTestEnv(testEnv);
});

beforeEach(async () => {
  await cleanTestEnv(testEnv);
  const user = await createTestUser(testEnv.db, { id: "user_chunk_test" });
  token = (await issueTestToken(testEnv.db, { userId: user.id })).rawToken;
});

function call(body: BodyInit, headers: Record<string, string> = {}) {
  const request = new Request("http://localhost/api/v1/uploads/sess/0", {
    method: "PUT",
    headers: { Authorization: bearerHeader(token) },
    body,
    duplex: "half",
  });
  const realHeaders = request.headers;
  Object.defineProperty(request, "headers", {
    value: {
      get: (name: string) =>
        headers[name] ?? headers[name.toLowerCase()] ?? realHeaders.get(name),
    },
  });
  return action({
    request,
    context: testLoadContext(testEnv),
    params: { id: "sess", chunk: "0" },
  });
}

describe("chunk body size guard", () => {
  it("rejects with 413 when Content-Length exceeds CHUNK_SIZE", async () => {
    const res = await call("x", { "Content-Length": String(CHUNK_SIZE + 1) });
    expect(res.status).toBe(413);
  });

  it("rejects with 413 when a streamed body without Content-Length exceeds CHUNK_SIZE", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(CHUNK_SIZE));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const res = await call(stream);
    expect(res.status).toBe(413);
  });

  it("lets a body within CHUNK_SIZE through to the service", async () => {
    const res = await call(new Uint8Array(16));
    expect(res.status).toBe(404);
  });
});
