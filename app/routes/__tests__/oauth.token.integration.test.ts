// @ts-nocheck
// @vitest-environment node
// HTTP-level test for POST /oauth/token
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TokenRepository } from "~/lib/auth/token-repository.server";
import { AuthorizationCodeRepository } from "~/lib/oauth/authorization-code-repository.server";
import { OAuthClientRepository } from "~/lib/oauth/oauth-client-repository.server";
import { OAuthGrantRepository } from "~/lib/oauth/oauth-grant-repository.server";
import { OAuthService } from "~/lib/oauth/oauth-service.server";
import { RefreshTokenRepository } from "~/lib/oauth/refresh-token-repository.server";
import {
  cleanTestEnv,
  createTestEnv,
  createTestUser,
  disposeTestEnv,
  type TestEnv,
  testLoadContext,
} from "~/test/integration-helpers";
import { action } from "../oauth.token";

let testEnv: TestEnv;
const USER_ID = "user_oauth_route";
const CLIENT_ID = "test-client";
const REDIRECT_URI = "http://127.0.0.1/callback";

function ctx() {
  return testLoadContext(testEnv);
}

function base64UrlEncode(buf: Uint8Array): string {
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  const verifier = base64UrlEncode(buf);
  const hashed = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64UrlEncode(new Uint8Array(hashed)) };
}

async function setupAndIssueCode(opts: { redirectUri?: string } = {}) {
  const redirectUri = opts.redirectUri ?? REDIRECT_URI;
  const oauth = new OAuthService(
    testEnv.db,
    USER_ID,
    new OAuthClientRepository(testEnv.db),
    new AuthorizationCodeRepository(testEnv.db),
    new TokenRepository(testEnv.db),
    new OAuthGrantRepository(),
    new RefreshTokenRepository(testEnv.db),
  );
  const { verifier, challenge } = await pkcePair();
  const v = await oauth.validateAuthorizeRequest({
    responseType: "code",
    clientId: CLIENT_ID,
    redirectUri,
    scope: "files",
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
  });
  if (!v.ok) throw new Error("validate failed");
  const issued = await oauth.issueAuthorizationCode(v.value, USER_ID, {
    paths: [{ path: "", access: "read" }],
  });
  if (!issued.ok) throw new Error("issue failed");
  return { code: issued.value.code, verifier };
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
     VALUES ($1, 'Test', ARRAY[$2], 'none')`,
    [CLIENT_ID, REDIRECT_URI],
  );
});

describe("POST /oauth/token", () => {
  it("exchanges authorization_code for tokens", async () => {
    const { code, verifier } = await setupAndIssueCode();

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      client_id: CLIENT_ID,
    });
    const res = await action({
      request: new Request("http://localhost/oauth/token", {
        method: "POST",
        body,
      }),
      context: ctx(),
      params: {},
    } as Parameters<typeof action>[0]);

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.token_type).toBe("Bearer");
    expect(typeof json.access_token).toBe("string");
    expect(typeof json.refresh_token).toBe("string");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects non-POST", async () => {
    const res = await action({
      request: new Request("http://localhost/oauth/token", { method: "GET" }),
      context: ctx(),
      params: {},
    } as Parameters<typeof action>[0]);
    expect(res.status).toBe(405);
  });

  it("rejects wrong content-type", async () => {
    const res = await action({
      request: new Request("http://localhost/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      context: ctx(),
      params: {},
    } as Parameters<typeof action>[0]);
    expect(res.status).toBe(400);
  });

  it("rejects unknown grant_type", async () => {
    const body = new URLSearchParams({
      grant_type: "password",
      client_id: CLIENT_ID,
    });
    const res = await action({
      request: new Request("http://localhost/oauth/token", {
        method: "POST",
        body,
      }),
      context: ctx(),
      params: {},
    } as Parameters<typeof action>[0]);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("unsupported_grant_type");
  });

  it("refreshes tokens", async () => {
    // First exchange to get a refresh_token
    const { code, verifier } = await setupAndIssueCode();
    const exRes = await action({
      request: new Request("http://localhost/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          client_id: CLIENT_ID,
        }),
      }),
      context: ctx(),
      params: {},
    } as Parameters<typeof action>[0]);
    const exJson = await exRes.json();

    const refreshRes = await action({
      request: new Request("http://localhost/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: exJson.refresh_token,
          client_id: CLIENT_ID,
        }),
      }),
      context: ctx(),
      params: {},
    } as Parameters<typeof action>[0]);
    expect(refreshRes.status).toBe(200);
    const refreshJson = await refreshRes.json();
    expect(refreshJson.access_token).not.toBe(exJson.access_token);
    expect(refreshJson.refresh_token).not.toBe(exJson.refresh_token);
  });
});
