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
import { loader } from "../api.token";

let testEnv: TestEnv;

function ctx() {
  return testLoadContext(testEnv);
}

beforeAll(async () => {
  testEnv = await createTestEnv();
});

afterAll(async () => {
  await disposeTestEnv(testEnv);
});

beforeEach(async () => {
  await cleanTestEnv(testEnv);
});

describe("GET /api/v1/token (Bearer-only introspection)", () => {
  it("does not leak base_path to token holders", async () => {
    const user = await createTestUser(testEnv.db, { id: "user_token_1" });
    const { rawToken } = await issueTestToken(testEnv.db, {
      userId: user.id,
      basePath: "/agents",
    });

    const res = await loader({
      request: new Request("http://localhost/api/v1/token", {
        headers: { Authorization: bearerHeader(rawToken) },
      }),
      context: ctx(),
      params: {},
    } as Parameters<typeof loader>[0]);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.user_id).toBe(user.id);
    expect(body).not.toHaveProperty("base_path");
    expect(body.access_paths).toBeInstanceOf(Array);
  });
});
