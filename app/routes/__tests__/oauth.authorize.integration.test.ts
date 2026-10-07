// @ts-nocheck
// @vitest-environment node
// Integration tests for the /oauth/authorize consent POST handler.
// Focuses on the server trust boundary: base_path validation, scope-write
// guard, and the "at least one path" requirement.
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
import { action } from "../oauth.authorize";

let testEnv: TestEnv;
const USER_ID = "user_oauth_consent";
const CLIENT_ID = "test-client-consent";
const REDIRECT_URI = "http://127.0.0.1/cb";
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function ctx() {
  return testLoadContext(testEnv);
}

async function consentRequest(
  body: Record<string, string | string[]>,
): Promise<Request> {
  const cookie = await sessionCookieHeader(USER_ID, testEnv.env);
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (Array.isArray(v)) {
      for (const item of v) form.append(k, item);
    } else {
      form.append(k, v);
    }
  }
  return new Request("http://localhost:8888/oauth/authorize", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: "http://localhost:8888",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
}

function baseFields(overrides: Record<string, string | string[]> = {}) {
  return {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "files",
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    decision: "allow",
    base_path: "/",
    path: ["docs"],
    access: ["write"],
    ...overrides,
  };
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
  await testEnv.db.execute(
    `INSERT INTO oauth_clients (id, client_name, redirect_uris, token_endpoint_auth_method)
     VALUES ($1, 'Consent Test App', ARRAY[$2], 'none')`,
    [CLIENT_ID, REDIRECT_URI],
  );
});

describe("POST /oauth/authorize action", () => {
  it("issues an authorization code on the happy path", async () => {
    const res = await action({
      request: await consentRequest(baseFields()),
      context: ctx(),
      params: {},
    } as Parameters<typeof action>[0]);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location") ?? "");
    expect(loc.searchParams.get("code")).toBeTruthy();
  });

  it("rejects invalid base_path (no leading slash)", async () => {
    const res = await action({
      request: await consentRequest(baseFields({ base_path: "no-slash" })),
      context: ctx(),
      params: {},
    } as Parameters<typeof action>[0]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("accepts path='' as canonical root access", async () => {
    const res = await action({
      request: await consentRequest(
        baseFields({ path: [""], access: ["write"] }),
      ),
      context: ctx(),
      params: {},
    } as Parameters<typeof action>[0]);
    expect(res.status).toBe(302);
  });

  it("rejects when no path fields are submitted (defense-in-depth against bypassed UI)", async () => {
    const res = await action({
      request: await consentRequest(baseFields({ path: [], access: [] })),
      context: ctx(),
      params: {},
    } as Parameters<typeof action>[0]);
    expect(res.status).toBe(400);
  });

  it("propagates resource into the issued code (RFC 8707 audience binding)", async () => {
    const resource = "http://localhost:8787/mcp";
    const res = await action({
      request: await consentRequest(baseFields({ resource })),
      context: ctx(),
      params: {},
    } as Parameters<typeof action>[0]);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location") ?? "");
    const code = loc.searchParams.get("code");
    expect(code).toBeTruthy();
    const { hashToken } = await import("~/lib/auth/token.server");
    const row = await testEnv.db.queryOne<{ resource: string | null }>(
      `SELECT resource FROM oauth_authorization_codes WHERE code_hash = $1`,
      [await hashToken(code as string)],
    );
    expect(row?.resource).toBe(resource);
  });

  it("returns access_denied to redirect_uri when user denies", async () => {
    const res = await action({
      request: await consentRequest(baseFields({ decision: "deny" })),
      context: ctx(),
      params: {},
    } as Parameters<typeof action>[0]);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location") ?? "");
    expect(loc.origin + loc.pathname).toBe(REDIRECT_URI);
    expect(loc.searchParams.get("error")).toBe("access_denied");
  });
});
