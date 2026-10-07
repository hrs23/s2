// @vitest-environment node
// Integration tests for POST /oauth/register (DCR, RFC 7591)
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanTestEnv,
  createTestEnv,
  disposeTestEnv,
  type TestEnv,
  testLoadContext,
} from "~/test/integration-helpers";
import { action } from "../oauth.register";

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

describe("POST /oauth/register", () => {
  it("registers a public client (PKCE) and returns RFC 7591 response", async () => {
    const res = await action({
      request: new Request("http://localhost/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Test Client",
          redirect_uris: ["https://example.com/cb"],
          token_endpoint_auth_method: "none",
        }),
      }),
      context: ctx(),
      params: {},
      // biome-ignore lint/suspicious/noExplicitAny: test
    } as any);

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.client_id).toBe("string");
    expect((body.client_id as string).startsWith("dcr_")).toBe(true);
    expect(body.client_secret).toBeUndefined(); // public client

    // Verify the row landed in oauth_clients (verification fields are gone in 0060)
    const row = await testEnv.db.queryOne<{
      id: string;
      client_name: string;
    }>("SELECT id, client_name FROM oauth_clients WHERE id = $1", [
      body.client_id,
    ]);
    expect(row?.id).toBe(body.client_id);
    expect(row?.client_name).toBe("Test Client");
  });

  it("registers a confidential client and issues client_secret", async () => {
    const res = await action({
      request: new Request("http://localhost/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Confidential",
          redirect_uris: ["https://app.example.com/oauth/cb"],
          token_endpoint_auth_method: "client_secret_basic",
        }),
      }),
      context: ctx(),
      params: {},
      // biome-ignore lint/suspicious/noExplicitAny: test
    } as any);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.client_secret).toBe("string");
  });

  it("rejects missing client_name with invalid_client_metadata", async () => {
    const res = await action({
      request: new Request("http://localhost/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://x/cb"],
        }),
      }),
      context: ctx(),
      params: {},
      // biome-ignore lint/suspicious/noExplicitAny: test
    } as any);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("rejects redirect_uri with fragment as invalid_redirect_uri", async () => {
    const res = await action({
      request: new Request("http://localhost/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Plain Name",
          redirect_uris: ["https://x/cb#frag"],
        }),
      }),
      context: ctx(),
      params: {},
      // biome-ignore lint/suspicious/noExplicitAny: test
    } as any);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("rejects http:// to non-loopback", async () => {
    const res = await action({
      request: new Request("http://localhost/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Plain Name",
          redirect_uris: ["http://attacker.example.com/cb"],
        }),
      }),
      context: ctx(),
      params: {},
      // biome-ignore lint/suspicious/noExplicitAny: test
    } as any);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("rejects reserved word in client_name", async () => {
    const res = await action({
      request: new Request("http://localhost/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Official Connector",
          redirect_uris: ["https://x/cb"],
        }),
      }),
      context: ctx(),
      params: {},
      // biome-ignore lint/suspicious/noExplicitAny: test
    } as any);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("rejects non-POST", async () => {
    const res = await action({
      request: new Request("http://localhost/oauth/register", {
        method: "GET",
      }),
      context: ctx(),
      params: {},
      // biome-ignore lint/suspicious/noExplicitAny: test
    } as any);
    expect(res.status).toBe(405);
  });

  it("rejects wrong content-type", async () => {
    const res = await action({
      request: new Request("http://localhost/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "client_name=foo",
      }),
      context: ctx(),
      params: {},
      // biome-ignore lint/suspicious/noExplicitAny: test
    } as any);
    expect(res.status).toBe(400);
  });
});
