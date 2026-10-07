// @vitest-environment node
//
// End-to-end flow tests for OAuthService:
// /authorize request → consent → /token (code exchange) → refresh → revoke
//
// There is no installation_id / device_label / verified. The multi-device
// contract is "a separate grant per per-install client_id".

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QuotaService } from "~/lib/auth/quota-service.server";
import { hashToken } from "~/lib/auth/token.server";
import { TokenRepository } from "~/lib/auth/token-repository.server";
import { UserRepository } from "~/lib/auth/user-repository.server";
import { AuthorizationCodeRepository } from "~/lib/oauth/authorization-code-repository.server";
import { OAuthClientRepository } from "~/lib/oauth/oauth-client-repository.server";
import { OAuthGrantRepository } from "~/lib/oauth/oauth-grant-repository.server";
import {
  DCR_QUOTA_MAX_PER_WINDOW,
  OAuthService,
  type ValidatedAuthorizeRequest,
} from "~/lib/oauth/oauth-service.server";
import { RefreshTokenRepository } from "~/lib/oauth/refresh-token-repository.server";
import {
  asTestTx,
  cleanTestEnv,
  createTestEnv,
  createTestUser,
  createUnissuedTestToken,
  disposeTestEnv,
  FINITE_TEST_LIMITS,
  type TestEnv,
} from "~/test/integration-helpers";

let tx: ReturnType<typeof asTestTx>;

let testEnv: TestEnv;
let service: OAuthService;
const USER_ID = "user_oauth_svc";
const CLIENT_ID = "test-client-pkce";
const REDIRECT_URI = "http://127.0.0.1/callback";

beforeAll(async () => {
  testEnv = await createTestEnv();
  tx = asTestTx(testEnv.db);
});

afterAll(async () => {
  await disposeTestEnv(testEnv);
});

beforeEach(async () => {
  await cleanTestEnv(testEnv);
  await createTestUser(testEnv.db, { id: USER_ID });

  // Pre-register a public client (PKCE only)
  await testEnv.db.execute(
    `INSERT INTO oauth_clients (id, client_name, redirect_uris, token_endpoint_auth_method)
     VALUES ($1, 'Test Client', ARRAY[$2], 'none')`,
    [CLIENT_ID, REDIRECT_URI],
  );

  const tokenRepo = new TokenRepository(testEnv.db);
  const userRepo = new UserRepository(testEnv.db);
  service = new OAuthService(
    testEnv.db,
    USER_ID,
    new OAuthClientRepository(testEnv.db),
    new AuthorizationCodeRepository(testEnv.db),
    tokenRepo,
    new OAuthGrantRepository(),
    new RefreshTokenRepository(testEnv.db),
    new QuotaService(userRepo, tokenRepo),
  );
});

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function base64UrlEncode(buf: Uint8Array): string {
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  const verifier = base64UrlEncode(buf);
  const hashed = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = base64UrlEncode(new Uint8Array(hashed));
  return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// validateAuthorizeRequest
// ---------------------------------------------------------------------------

describe("validateAuthorizeRequest — redirect_uri matching", () => {
  it("accepts non-loopback URI when registered exactly", async () => {
    const externalClient = "test-external";
    const externalUri = "https://example.com/callback";
    await testEnv.db.execute(
      `INSERT INTO oauth_clients (id, client_name, redirect_uris, token_endpoint_auth_method)
       VALUES ($1, 'Test', ARRAY[$2], 'none')`,
      [externalClient, externalUri],
    );
    const { challenge } = await pkcePair();
    const result = await service.validateAuthorizeRequest({
      responseType: "code",
      clientId: externalClient,
      redirectUri: externalUri,
      scope: "files",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects non-loopback URI when not exact (no port flex outside loopback)", async () => {
    const externalClient = "test-external-2";
    const externalUri = "https://example.com/callback";
    await testEnv.db.execute(
      `INSERT INTO oauth_clients (id, client_name, redirect_uris, token_endpoint_auth_method)
       VALUES ($1, 'Test', ARRAY[$2], 'none')`,
      [externalClient, externalUri],
    );
    const { challenge } = await pkcePair();
    const result = await service.validateAuthorizeRequest({
      responseType: "code",
      clientId: externalClient,
      redirectUri: "https://example.com:8080/callback", // different port
      scope: "files",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    if (result.ok) throw new Error("expected error");
    expect(result.error.error).toBe("invalid_request");
  });

  it("rejects malformed presented redirect_uri", async () => {
    const { challenge } = await pkcePair();
    const result = await service.validateAuthorizeRequest({
      responseType: "code",
      clientId: CLIENT_ID,
      redirectUri: "not-a-url",
      scope: "files",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    if (result.ok) throw new Error("expected error");
    expect(result.error.error).toBe("invalid_request");
  });

  it("ignores malformed registered URIs (skips and tries next)", async () => {
    const partialClient = "test-partial-bad";
    await testEnv.db.execute(
      `INSERT INTO oauth_clients (id, client_name, redirect_uris, token_endpoint_auth_method)
       VALUES ($1, 'Test', ARRAY['::not-a-url::', $2], 'none')`,
      [partialClient, REDIRECT_URI],
    );
    const { challenge } = await pkcePair();
    const result = await service.validateAuthorizeRequest({
      responseType: "code",
      clientId: partialClient,
      redirectUri: REDIRECT_URI,
      scope: "files",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateAuthorizeRequest", () => {
  it("accepts a valid request", async () => {
    const { challenge } = await pkcePair();
    const result = await service.validateAuthorizeRequest({
      responseType: "code",
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: "files",
      state: "abc",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects unknown client", async () => {
    const { challenge } = await pkcePair();
    const result = await service.validateAuthorizeRequest({
      responseType: "code",
      clientId: "nope",
      redirectUri: REDIRECT_URI,
      scope: "files",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    if (result.ok) throw new Error("expected error");
    expect(result.error.error).toBe("invalid_client");
  });

  it("rejects mismatched redirect_uri", async () => {
    const { challenge } = await pkcePair();
    const result = await service.validateAuthorizeRequest({
      responseType: "code",
      clientId: CLIENT_ID,
      redirectUri: "http://evil.example.com/callback",
      scope: "files",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    if (result.ok) throw new Error("expected error");
    expect(result.error.error).toBe("invalid_request");
  });

  it("accepts loopback redirect with arbitrary port (RFC 8252)", async () => {
    const { challenge } = await pkcePair();
    const result = await service.validateAuthorizeRequest({
      responseType: "code",
      clientId: CLIENT_ID,
      redirectUri: "http://127.0.0.1:54321/callback",
      scope: "files",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects unsupported scope", async () => {
    const { challenge } = await pkcePair();
    const result = await service.validateAuthorizeRequest({
      responseType: "code",
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: "unknown:scope",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    if (result.ok) throw new Error("expected error");
    expect(result.error.error).toBe("invalid_scope");
  });

  it("rejects non-S256 code_challenge_method", async () => {
    const result = await service.validateAuthorizeRequest({
      responseType: "code",
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: "files",
      codeChallenge: "x",
      codeChallengeMethod: "plain",
    });
    if (result.ok) throw new Error("expected error");
    expect(result.error.error).toBe("invalid_request");
  });
});

// ---------------------------------------------------------------------------
// issueAuthorizationCode + exchangeCode (full happy path)
// ---------------------------------------------------------------------------

async function happyPathAuthorize(
  opts: {
    basePath?: string;
    paths?: Array<{ path: string; access: "read" | "write" }>;
    clientId?: string;
  } = {},
): Promise<{
  verifier: string;
  code: string;
  request: ValidatedAuthorizeRequest;
}> {
  const { verifier, challenge } = await pkcePair();
  const result = await service.validateAuthorizeRequest({
    responseType: "code",
    clientId: opts.clientId ?? CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scope: "files",
    state: "test-state",
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
  });
  if (!result.ok) throw new Error(`validate failed: ${result.error.error}`);
  const issued = await service.issueAuthorizationCode(result.value, USER_ID, {
    basePath: opts.basePath ?? "/",
    paths: opts.paths ?? [{ path: "notes", access: "read" }],
  });
  if (!issued.ok) throw new Error(`issue failed: ${issued.error.error}`);
  return { verifier, code: issued.value.code, request: result.value };
}

describe("exchangeCode (happy path)", () => {
  it("issues access_token + refresh_token after successful PKCE exchange", async () => {
    const { verifier, code } = await happyPathAuthorize();
    const ex = await service.exchangeCode({
      code,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      clientId: CLIENT_ID,
    });
    if (!ex.ok)
      throw new Error(`exchange failed: ${ex.error.error_description}`);
    expect(ex.value.access_token).toMatch(/^s2_/);
    expect(ex.value.refresh_token).toMatch(/^s2_/);
    expect(ex.value.token_type).toBe("Bearer");
    expect(ex.value.expires_in).toBeGreaterThan(0);
  });

  it("creates an oauth_grants row for the user/client", async () => {
    const { verifier, code } = await happyPathAuthorize();
    await service.exchangeCode({
      code,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      clientId: CLIENT_ID,
    });
    const rows = await testEnv.db.query<{
      grant_id: string;
      oauth_client_id: string;
    }>(
      "SELECT grant_id, oauth_client_id FROM oauth_grants WHERE user_id = $1",
      [USER_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].oauth_client_id).toBe(CLIENT_ID);
  });

  it("API gate can resolve grant by access_token hash", async () => {
    const { verifier, code } = await happyPathAuthorize();
    const ex = await service.exchangeCode({
      code,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      clientId: CLIENT_ID,
    });
    if (!ex.ok) throw new Error("exchange failed");

    const repo = new TokenRepository(testEnv.db);
    const auth = await repo.findByHash(await hashToken(ex.value.access_token));
    expect(auth).not.toBeNull();
    expect(auth?.user_id).toBe(USER_ID);
  });
});

describe("issueAuthorizationCode validation", () => {
  it("rejects path with leading /", async () => {
    const { verifier: _v, challenge } = await pkcePair();
    const validated = await service.validateAuthorizeRequest({
      responseType: "code",
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: "files",
      state: "s",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    if (!validated.ok) throw new Error("validate failed");
    const issued = await service.issueAuthorizationCode(
      validated.value,
      USER_ID,
      { basePath: "/", paths: [{ path: "/docs", access: "read" }] },
    );
    if (issued.ok) throw new Error("expected failure");
    expect(issued.error.error).toBe("invalid_request");
  });

  it("canonicalizes trailing slash and rejects post-canonical duplicates", async () => {
    const { challenge } = await pkcePair();
    const validated = await service.validateAuthorizeRequest({
      responseType: "code",
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: "files",
      state: "s",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    if (!validated.ok) throw new Error("validate failed");
    const dup = await service.issueAuthorizationCode(validated.value, USER_ID, {
      basePath: "/",
      paths: [
        { path: "foo", access: "read" },
        { path: "foo/", access: "write" },
      ],
    });
    if (dup.ok) throw new Error("expected duplicate failure");
    expect(dup.error.error).toBe("invalid_request");
  });
});

describe("exchangeCode (failure modes)", () => {
  it("rejects when code is reused", async () => {
    const { verifier, code } = await happyPathAuthorize();
    const first = await service.exchangeCode({
      code,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      clientId: CLIENT_ID,
    });
    expect(first.ok).toBe(true);
    const second = await service.exchangeCode({
      code,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      clientId: CLIENT_ID,
    });
    if (second.ok) throw new Error("expected error");
    expect(second.error.error).toBe("invalid_grant");
  });

  it("rejects mismatched code_verifier (PKCE failure)", async () => {
    const { code } = await happyPathAuthorize();
    const ex = await service.exchangeCode({
      code,
      redirectUri: REDIRECT_URI,
      codeVerifier: "wrong-verifier",
      clientId: CLIENT_ID,
    });
    if (ex.ok) throw new Error("expected error");
    expect(ex.error.error).toBe("invalid_grant");
  });

  it("rejects mismatched redirect_uri", async () => {
    const { verifier, code } = await happyPathAuthorize();
    const ex = await service.exchangeCode({
      code,
      redirectUri: "http://127.0.0.1:9999/other",
      codeVerifier: verifier,
      clientId: CLIENT_ID,
    });
    if (ex.ok) throw new Error("expected error");
    expect(ex.error.error).toBe("invalid_grant");
  });

  it("rejects when public client presents client_secret", async () => {
    const { verifier, code } = await happyPathAuthorize();
    const ex = await service.exchangeCode({
      code,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      clientId: CLIENT_ID,
      clientSecret: "should-not-be-here",
    });
    if (ex.ok) throw new Error("expected error");
    expect(ex.error.error).toBe("invalid_client");
  });
});

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

describe("refreshAccessToken", () => {
  it("rotates both access and refresh tokens", async () => {
    const { verifier, code } = await happyPathAuthorize();
    const first = await service.exchangeCode({
      code,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      clientId: CLIENT_ID,
    });
    if (!first.ok) throw new Error("first exchange failed");
    const refreshToken1 = first.value.refresh_token;
    if (!refreshToken1) throw new Error("missing refresh_token");

    const refreshed = await service.refreshAccessToken({
      refreshToken: refreshToken1,
      clientId: CLIENT_ID,
    });
    if (!refreshed.ok)
      throw new Error(`refresh failed: ${refreshed.error.error_description}`);
    expect(refreshed.value.access_token).not.toBe(first.value.access_token);
    expect(refreshed.value.refresh_token).not.toBe(refreshToken1);
  });

  it("invalidates the old refresh_token after rotation", async () => {
    const { verifier, code } = await happyPathAuthorize();
    const first = await service.exchangeCode({
      code,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      clientId: CLIENT_ID,
    });
    if (!first.ok || !first.value.refresh_token) throw new Error("setup");
    const oldRefresh = first.value.refresh_token;

    const r1 = await service.refreshAccessToken({
      refreshToken: oldRefresh,
      clientId: CLIENT_ID,
    });
    expect(r1.ok).toBe(true);

    // Past the grace window, the rotated-away token is permanently invalid.
    await testEnv.db.execute(
      "UPDATE refresh_tokens SET used_at = now() - interval '5 minutes' WHERE token_hash = $1",
      [await hashToken(oldRefresh)],
    );

    const r2 = await service.refreshAccessToken({
      refreshToken: oldRefresh,
      clientId: CLIENT_ID,
    });
    if (r2.ok) throw new Error("expected error");
    expect(r2.error.error).toBe("invalid_grant");
  });

  it("rejects wrong-client refresh without revoking family", async () => {
    // Register a second public client (= different client_id, same user).
    const OTHER_CLIENT_ID = "test-client-other";
    await testEnv.db.execute(
      `INSERT INTO oauth_clients (id, client_name, redirect_uris, token_endpoint_auth_method)
       VALUES ($1, 'Other Client', ARRAY[$2], 'none')`,
      [OTHER_CLIENT_ID, REDIRECT_URI],
    );

    // Issue a refresh_token for CLIENT_ID via the full PKCE flow.
    const { verifier, code } = await happyPathAuthorize();
    const first = await service.exchangeCode({
      code,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      clientId: CLIENT_ID,
    });
    if (!first.ok || !first.value.refresh_token) throw new Error("setup");
    const refreshToken = first.value.refresh_token;

    // Present that refresh_token as the *other* client → invalid_grant.
    const wrong = await service.refreshAccessToken({
      refreshToken,
      clientId: OTHER_CLIENT_ID,
    });
    if (wrong.ok) throw new Error("expected error");
    expect(wrong.error.error).toBe("invalid_grant");
    expect(wrong.error.error_description).toBe("client mismatch");

    // used_at must still be NULL (no consume) and the row not revoked.
    const refreshHash = await hashToken(refreshToken);
    const rows = await testEnv.db.query<{
      used_at: string | null;
      revoked_at: string | null;
      revocation_reason: string | null;
    }>(
      "SELECT used_at, revoked_at, revocation_reason FROM refresh_tokens WHERE token_hash = $1",
      [refreshHash],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].used_at).toBeNull();
    expect(rows[0].revoked_at).toBeNull();
    expect(rows[0].revocation_reason).toBeNull();

    // The legitimate client can still use the same refresh_token.
    const recovered = await service.refreshAccessToken({
      refreshToken,
      clientId: CLIENT_ID,
    });
    if (!recovered.ok)
      throw new Error(
        `recovery refresh failed: ${recovered.error.error_description}`,
      );
    expect(recovered.value.access_token).not.toBe(first.value.access_token);
    expect(recovered.value.refresh_token).not.toBe(refreshToken);
  });
});

// ---------------------------------------------------------------------------
// DCR / audience binding / cleanup
// ---------------------------------------------------------------------------

describe("registerDcrClient", () => {
  it("creates a public client without secret", async () => {
    const r = await service.registerDcrClient({
      clientName: "DCR Public",
      redirectUris: ["https://example.com/cb"],
    });
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.client_id.startsWith("dcr_")).toBe(true);
    expect(r.value.client_secret).toBeUndefined();
  });

  it("creates a confidential client with hashed secret", async () => {
    const r = await service.registerDcrClient({
      clientName: "DCR Confidential",
      redirectUris: ["https://example.com/cb"],
      tokenEndpointAuthMethod: "client_secret_basic",
    });
    if (!r.ok) throw new Error("expected ok");
    expect(typeof r.value.client_secret).toBe("string");
  });

  it("rejects empty client_name as invalid_client_metadata", async () => {
    const r = await service.registerDcrClient({
      clientName: "",
      redirectUris: ["https://x/cb"],
    });
    if (r.ok) throw new Error("expected error");
    expect(r.error.error).toBe("invalid_client_metadata");
  });

  it("rejects empty redirect_uris", async () => {
    const r = await service.registerDcrClient({
      clientName: "Reasonable Name",
      redirectUris: [],
    });
    if (r.ok) throw new Error("expected error");
    expect(r.error.error).toBe("invalid_redirect_uri");
  });

  it("rejects redirect_uri with fragment", async () => {
    const r = await service.registerDcrClient({
      clientName: "Reasonable Name",
      redirectUris: ["https://x/cb#frag"],
    });
    if (r.ok) throw new Error("expected error");
    expect(r.error.error).toBe("invalid_redirect_uri");
  });

  it("rejects malformed redirect_uri", async () => {
    const r = await service.registerDcrClient({
      clientName: "Reasonable Name",
      redirectUris: ["not-a-url"],
    });
    if (r.ok) throw new Error("expected error");
    expect(r.error.error).toBe("invalid_redirect_uri");
  });

  it("rejects http:// to non-loopback host (allowlist)", async () => {
    const r = await service.registerDcrClient({
      clientName: "Reasonable Name",
      redirectUris: ["http://attacker.example.com/cb"],
    });
    if (r.ok) throw new Error("expected error");
    expect(r.error.error).toBe("invalid_redirect_uri");
  });

  it("rejects custom scheme redirect (allowlist)", async () => {
    const r = await service.registerDcrClient({
      clientName: "Reasonable Name",
      redirectUris: ["myapp://callback"],
    });
    if (r.ok) throw new Error("expected error");
    expect(r.error.error).toBe("invalid_redirect_uri");
  });

  it("accepts http:// loopback redirect", async () => {
    const r = await service.registerDcrClient({
      clientName: "Reasonable Name",
      redirectUris: ["http://127.0.0.1:51234/callback"],
    });
    if (!r.ok) throw new Error(`expected ok: ${r.error.error_description}`);
  });

  it("rejects reserved word in client_name (official)", async () => {
    const r = await service.registerDcrClient({
      clientName: "Official Connector",
      redirectUris: ["https://x/cb"],
    });
    if (r.ok) throw new Error("expected error");
    expect(r.error.error).toBe("invalid_client_metadata");
  });

  it("rejects reserved word in client_name (Official)", async () => {
    const r = await service.registerDcrClient({
      clientName: "Official Sync",
      redirectUris: ["https://x/cb"],
    });
    if (r.ok) throw new Error("expected error");
    expect(r.error.error).toBe("invalid_client_metadata");
  });

  it("rejects oversized client_name", async () => {
    const r = await service.registerDcrClient({
      clientName: "x".repeat(200),
      redirectUris: ["https://x/cb"],
    });
    if (r.ok) throw new Error("expected error");
    expect(r.error.error).toBe("invalid_client_metadata");
  });

  it("rejects control character in client_name", async () => {
    const r = await service.registerDcrClient({
      clientName: `Bad${String.fromCharCode(7)}Name`,
      redirectUris: ["https://x/cb"],
    });
    if (r.ok) throw new Error("expected error");
    expect(r.error.error).toBe("invalid_client_metadata");
  });

  it("returns too_many_requests when registration quota exceeded", async () => {
    // Pre-seed enough oauth_clients rows in the trailing window to hit quota.
    // Use individual INSERTs because PGlite parameter binding caps below the
    // batch size we'd need otherwise (~300 placeholders for 100 rows).
    for (let i = 0; i < DCR_QUOTA_MAX_PER_WINDOW; i++) {
      await testEnv.db.execute(
        `INSERT INTO oauth_clients (id, client_name, redirect_uris, token_endpoint_auth_method)
         VALUES ($1, $2, ARRAY[$3], 'none')`,
        [`dcr_quota_seed_${i}`, `Quota seed ${i}`, "https://example.com/cb"],
      );
    }
    const r = await service.registerDcrClient({
      clientName: "One More",
      redirectUris: ["https://x/cb"],
    });
    if (r.ok) throw new Error("expected too_many_requests");
    expect(r.error.error).toBe("too_many_requests");
  });
});

describe("cleanupUnusedDcrClients", () => {
  // Rows are hard-deleted (no soft-delete via deleted_at).
  it("hard-deletes DCR clients with no grants older than threshold", async () => {
    const r = await service.registerDcrClient({
      clientName: "Stale",
      redirectUris: ["https://x/cb"],
    });
    if (!r.ok) throw new Error("setup");
    await testEnv.db.execute(
      `UPDATE oauth_clients SET created_at = now() - INTERVAL '60 days' WHERE id = $1`,
      [r.value.client_id],
    );

    // biome-ignore lint/suspicious/noExplicitAny: test access to private member
    const repo = (service as any).clientRepo;
    const count = await repo.cleanupUnusedDcrClients(30);
    expect(count).toBeGreaterThanOrEqual(1);

    const row = await testEnv.db.queryOne<{ id: string }>(
      "SELECT id FROM oauth_clients WHERE id = $1",
      [r.value.client_id],
    );
    expect(row).toBeNull();
  });

  it("preserves DCR clients with attached grants", async () => {
    const r = await service.registerDcrClient({
      clientName: "Active",
      redirectUris: ["https://y/cb"],
    });
    if (!r.ok) throw new Error("setup");
    await testEnv.db.execute(
      `INSERT INTO grants (id, user_id, base_path, created_at)
       VALUES ('grt_active_test', $1, '/', now() - INTERVAL '60 days')`,
      [USER_ID],
    );
    await testEnv.db.execute(
      `INSERT INTO oauth_grants (grant_id, user_id, oauth_client_id, oauth_requested_scopes)
       VALUES ('grt_active_test', $1, $2, ARRAY['files'])`,
      [USER_ID, r.value.client_id],
    );
    await testEnv.db.execute(
      `UPDATE oauth_clients SET created_at = now() - INTERVAL '60 days' WHERE id = $1`,
      [r.value.client_id],
    );

    // biome-ignore lint/suspicious/noExplicitAny: test access to private member
    const repo = (service as any).clientRepo;
    await repo.cleanupUnusedDcrClients(30);

    const row = await testEnv.db.queryOne<{ id: string }>(
      "SELECT id FROM oauth_clients WHERE id = $1",
      [r.value.client_id],
    );
    expect(row?.id).toBe(r.value.client_id);
  });

  // oauth_clients DELETE cascades to grants via an AFTER DELETE trigger;
  // access_tokens / grant_paths / refresh_tokens must all disappear
  // with it.
  it("DELETE FROM oauth_clients cascades to access_tokens / grant_paths / refresh_tokens via trigger", async () => {
    // Full OAuth flow: create client → authorize → exchange → refresh_token / access_token / grant_paths exist
    const { verifier, code } = await happyPathAuthorize();
    const ex = await service.exchangeCode({
      code,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      clientId: CLIENT_ID,
    });
    if (!ex.ok) throw new Error("setup");

    const grantBefore = await testEnv.db.queryOne<{ id: string }>(
      "SELECT id FROM grants WHERE user_id = $1",
      [USER_ID],
    );
    if (!grantBefore) throw new Error("grant missing");
    const grantId = grantBefore.id;

    // Precondition: related tokens / paths exist
    const atBefore = await testEnv.db.query(
      "SELECT grant_id FROM access_tokens WHERE grant_id = $1",
      [grantId],
    );
    expect(atBefore.length).toBeGreaterThanOrEqual(1);
    const rtBefore = await testEnv.db.query(
      "SELECT id FROM refresh_tokens WHERE grant_id = $1",
      [grantId],
    );
    expect(rtBefore.length).toBeGreaterThanOrEqual(1);
    const tgpBefore = await testEnv.db.query(
      "SELECT path FROM grant_paths WHERE grant_id = $1",
      [grantId],
    );
    expect(tgpBefore.length).toBeGreaterThanOrEqual(1);

    // Hard-delete the client (CASCADE)
    await testEnv.db.execute("DELETE FROM oauth_clients WHERE id = $1", [
      CLIENT_ID,
    ]);

    // Everything must be gone via the trigger
    const og = await testEnv.db.query(
      "SELECT grant_id FROM oauth_grants WHERE grant_id = $1",
      [grantId],
    );
    expect(og).toHaveLength(0);
    const tg = await testEnv.db.query("SELECT id FROM grants WHERE id = $1", [
      grantId,
    ]);
    expect(tg).toHaveLength(0);
    const at = await testEnv.db.query(
      "SELECT grant_id FROM access_tokens WHERE grant_id = $1",
      [grantId],
    );
    expect(at).toHaveLength(0);
    const rt = await testEnv.db.query(
      "SELECT id FROM refresh_tokens WHERE grant_id = $1",
      [grantId],
    );
    expect(rt).toHaveLength(0);
    const tgp = await testEnv.db.query(
      "SELECT path FROM grant_paths WHERE grant_id = $1",
      [grantId],
    );
    expect(tgp).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// revoke (grant cascade)
// ---------------------------------------------------------------------------

describe("revokeGrant", () => {
  it("cascades to remove access_tokens and refresh_tokens", async () => {
    const { verifier, code } = await happyPathAuthorize();
    await service.exchangeCode({
      code,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      clientId: CLIENT_ID,
    });
    const grant = await testEnv.db.queryOne<{ id: string }>(
      "SELECT id FROM grants WHERE user_id = $1",
      [USER_ID],
    );
    if (!grant) throw new Error("grant missing");

    const ok = await service.revokeGrantOwned(grant.id, USER_ID);
    expect(ok).toBe(true);

    const grants = await testEnv.db.query(
      "SELECT id FROM grants WHERE user_id = $1",
      [USER_ID],
    );
    expect(grants).toHaveLength(0);
    const at = await testEnv.db.query(
      "SELECT grant_id FROM access_tokens WHERE grant_id = $1",
      [grant.id],
    );
    expect(at).toHaveLength(0);
    const rt = await testEnv.db.query(
      "SELECT grant_id FROM refresh_tokens WHERE grant_id = $1",
      [grant.id],
    );
    expect(rt).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// updateGrantOwned — user-driven edit from /connections page
// ---------------------------------------------------------------------------

describe("updateGrantOwned", () => {
  async function setupGrant(): Promise<string> {
    const { verifier, code } = await happyPathAuthorize({
      paths: [{ path: "notes", access: "read" }],
    });
    const ex = await service.exchangeCode({
      code,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      clientId: CLIENT_ID,
    });
    if (!ex.ok) throw new Error("setup");
    const g = await testEnv.db.queryOne<{ id: string }>(
      "SELECT id FROM grants WHERE user_id = $1",
      [USER_ID],
    );
    if (!g) throw new Error("grant missing");
    return g.id;
  }

  it("replaces base_path and access paths", async () => {
    const grantId = await setupGrant();
    const ok = await service.updateGrantOwned(grantId, USER_ID, {
      basePath: "/work",
      paths: [
        { path: "docs", access: "write" },
        { path: "inbox", access: "read" },
      ],
    });
    if (!ok.ok) throw new Error(`update failed: ${ok.error.message}`);

    const grant = await testEnv.db.queryOne<{ base_path: string }>(
      "SELECT base_path FROM grants WHERE id = $1",
      [grantId],
    );
    expect(grant?.base_path).toBe("/work");

    const paths = await testEnv.db.query<{ path: string; access: string }>(
      "SELECT path, access FROM grant_paths WHERE grant_id = $1 ORDER BY path",
      [grantId],
    );
    expect(paths).toEqual([
      { path: "docs", access: "write" },
      { path: "inbox", access: "read" },
    ]);
  });

  it("does not invalidate the existing access_token", async () => {
    const grantId = await setupGrant();
    const before = await testEnv.db.query<{ token_hash: string }>(
      "SELECT token_hash FROM access_tokens WHERE grant_id = $1",
      [grantId],
    );
    expect(before).toHaveLength(1);

    const ok = await service.updateGrantOwned(grantId, USER_ID, {
      basePath: "/",
      paths: [{ path: "photos", access: "write" }],
    });
    expect(ok.ok).toBe(true);

    const after = await testEnv.db.query<{ token_hash: string }>(
      "SELECT token_hash FROM access_tokens WHERE grant_id = $1",
      [grantId],
    );
    expect(after).toHaveLength(1);
    expect(after[0].token_hash).toBe(before[0].token_hash);
  });

  it("rejects when grantId belongs to another user", async () => {
    const grantId = await setupGrant();
    const ok = await service.updateGrantOwned(grantId, "user_other", {
      basePath: "/",
      paths: [{ path: "x", access: "read" }],
    });
    if (ok.ok) throw new Error("expected failure");
    expect(ok.error.code).toBe("not_found");
  });

  it("returns not_found instead of crashing when revoke wins the race", async () => {
    const grantId = await setupGrant();
    await service.revokeGrantOwned(grantId, USER_ID);

    const ok = await service.updateGrantOwned(grantId, USER_ID, {
      basePath: "/",
      paths: [{ path: "x", access: "read" }],
    });
    if (ok.ok) throw new Error("expected failure");
    expect(ok.error.code).toBe("not_found");
  });

  it("rejects empty paths", async () => {
    const grantId = await setupGrant();
    const ok = await service.updateGrantOwned(grantId, USER_ID, {
      basePath: "/",
      paths: [],
    });
    if (ok.ok) throw new Error("expected failure");
    expect(ok.error.code).toBe("invalid_request");
  });

  it("rejects invalid base_path", async () => {
    const grantId = await setupGrant();
    const ok = await service.updateGrantOwned(grantId, USER_ID, {
      basePath: "no-leading-slash",
      paths: [{ path: "x", access: "read" }],
    });
    if (ok.ok) throw new Error("expected failure");
    expect(ok.error.code).toBe("invalid_request");
  });

  it("rejects path with leading /", async () => {
    const grantId = await setupGrant();
    const ok = await service.updateGrantOwned(grantId, USER_ID, {
      basePath: "/",
      paths: [{ path: "/docs", access: "read" }],
    });
    if (ok.ok) throw new Error("expected failure");
    expect(ok.error.code).toBe("invalid_request");
  });

  it("rejects path containing ..", async () => {
    const grantId = await setupGrant();
    const ok = await service.updateGrantOwned(grantId, USER_ID, {
      basePath: "/",
      paths: [{ path: "../etc", access: "read" }],
    });
    if (ok.ok) throw new Error("expected failure");
    expect(ok.error.code).toBe("invalid_request");
  });

  it("canonicalizes trailing slash and rejects post-canonical duplicates", async () => {
    const grantId = await setupGrant();

    const dup = await service.updateGrantOwned(grantId, USER_ID, {
      basePath: "/",
      paths: [
        { path: "foo", access: "read" },
        { path: "foo/", access: "write" },
      ],
    });
    if (dup.ok) throw new Error("expected duplicate failure");
    expect(dup.error.code).toBe("invalid_request");

    const ok = await service.updateGrantOwned(grantId, USER_ID, {
      basePath: "/",
      paths: [{ path: "bar/", access: "read" }],
    });
    if (!ok.ok) throw new Error("expected success");
  });
});

// ---------------------------------------------------------------------------
// Re-consent: same (user, client) reuses grant and replaces paths
// ---------------------------------------------------------------------------

describe("re-consent", () => {
  it("updates paths on re-consent without creating a new grant", async () => {
    const first = await happyPathAuthorize({
      paths: [{ path: "notes", access: "read" }],
    });
    const ex1 = await service.exchangeCode({
      code: first.code,
      redirectUri: REDIRECT_URI,
      codeVerifier: first.verifier,
      clientId: CLIENT_ID,
    });
    expect(ex1.ok).toBe(true);

    const second = await happyPathAuthorize({
      paths: [{ path: "photos", access: "write" }],
    });
    const ex2 = await service.exchangeCode({
      code: second.code,
      redirectUri: REDIRECT_URI,
      codeVerifier: second.verifier,
      clientId: CLIENT_ID,
    });
    expect(ex2.ok).toBe(true);

    const grants = await testEnv.db.query(
      "SELECT id FROM grants WHERE user_id = $1",
      [USER_ID],
    );
    expect(grants).toHaveLength(1);

    const paths = await testEnv.db.query<{ path: string; access: string }>(
      "SELECT path, access FROM grant_paths WHERE grant_id = $1",
      [(grants[0] as { id: string }).id],
    );
    expect(paths).toHaveLength(1);
    expect(paths[0].path).toBe("photos");
    expect(paths[0].access).toBe("write");
  });

  it("re-consent updates resource and oauth_requested_scopes on the existing grant", async () => {
    const first = await happyPathAuthorize();
    await service.exchangeCode({
      code: first.code,
      redirectUri: REDIRECT_URI,
      codeVerifier: first.verifier,
      clientId: CLIENT_ID,
    });
    let row = await testEnv.db.queryOne<{ resource: string | null }>(
      "SELECT resource FROM oauth_grants WHERE user_id = $1",
      [USER_ID],
    );
    expect(row?.resource).toBeNull();

    const { verifier, challenge } = await pkcePair();
    const validated = await service.validateAuthorizeRequest({
      responseType: "code",
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: "files",
      state: "s",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      resource: "http://localhost:8787/mcp",
    });
    if (!validated.ok) throw new Error("validate");
    const issued = await service.issueAuthorizationCode(
      validated.value,
      USER_ID,
      { paths: [{ path: "", access: "write" }] },
    );
    if (!issued.ok) throw new Error("issue");
    await service.exchangeCode({
      code: issued.value.code,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      clientId: CLIENT_ID,
      resource: "http://localhost:8787/mcp",
    });

    row = await testEnv.db.queryOne<{ resource: string | null }>(
      "SELECT resource FROM oauth_grants WHERE user_id = $1",
      [USER_ID],
    );
    expect(row?.resource).toBe("http://localhost:8787/mcp");
  });

  it("re-consent invalidates prior refresh tokens for the grant", async () => {
    const first = await happyPathAuthorize();
    const ex1 = await service.exchangeCode({
      code: first.code,
      redirectUri: REDIRECT_URI,
      codeVerifier: first.verifier,
      clientId: CLIENT_ID,
    });
    if (!ex1.ok || !ex1.value.refresh_token) throw new Error("setup");
    const oldRefresh = ex1.value.refresh_token;

    const second = await happyPathAuthorize();
    const ex2 = await service.exchangeCode({
      code: second.code,
      redirectUri: REDIRECT_URI,
      codeVerifier: second.verifier,
      clientId: CLIENT_ID,
    });
    expect(ex2.ok).toBe(true);

    const r = await service.refreshAccessToken({
      refreshToken: oldRefresh,
      clientId: CLIENT_ID,
    });
    if (r.ok) throw new Error("expected error");
    expect(r.error.error).toBe("invalid_grant");
    expect(r.error.error_description).toMatch(/revoked/i);
  });
});

describe("refresh reuse detection", () => {
  it("revokes the grant when a rotated refresh token is reused after the grace window", async () => {
    const { code, verifier } = await happyPathAuthorize();
    const first = await service.exchangeCode({
      code,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      clientId: CLIENT_ID,
    });
    if (!first.ok || !first.value.refresh_token) throw new Error("setup");
    const oldRefresh = first.value.refresh_token;

    const r1 = await service.refreshAccessToken({
      refreshToken: oldRefresh,
      clientId: CLIENT_ID,
    });
    expect(r1.ok).toBe(true);

    // Push consumption past the grace window so the re-presentation is
    // treated as compromise rather than a crash retry.
    await testEnv.db.execute(
      "UPDATE refresh_tokens SET used_at = now() - interval '5 minutes' WHERE token_hash = $1",
      [await hashToken(oldRefresh)],
    );

    const r2 = await service.refreshAccessToken({
      refreshToken: oldRefresh,
      clientId: CLIENT_ID,
    });
    if (r2.ok) throw new Error("expected reuse detection error");
    expect(r2.error.error).toBe("invalid_grant");
    expect(r2.error.error_description).toMatch(/reuse/i);

    const grants = await testEnv.db.query(
      "SELECT id FROM grants WHERE user_id = $1",
      [USER_ID],
    );
    expect(grants).toHaveLength(0);
  });

  it("re-rotates (no cascade) when a refresh token is reused within the grace window", async () => {
    // Models a client that crashed / lost the response before persisting the
    // rotated token, then retried with the old token shortly after.
    const { code, verifier } = await happyPathAuthorize();
    const first = await service.exchangeCode({
      code,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      clientId: CLIENT_ID,
    });
    if (!first.ok || !first.value.refresh_token) throw new Error("setup");
    const oldRefresh = first.value.refresh_token;

    const r1 = await service.refreshAccessToken({
      refreshToken: oldRefresh,
      clientId: CLIENT_ID,
    });
    if (!r1.ok || !r1.value.refresh_token) throw new Error("r1");
    const orphanChild = r1.value.refresh_token;

    // Immediate re-presentation of the old token: inside the grace window.
    const r2 = await service.refreshAccessToken({
      refreshToken: oldRefresh,
      clientId: CLIENT_ID,
    });
    if (!r2.ok || !r2.value.refresh_token) throw new Error("expected grace ok");
    const graceChild = r2.value.refresh_token;
    expect(graceChild).not.toBe(orphanChild);

    // Grant survives — no cascade.
    const grants = await testEnv.db.query(
      "SELECT id FROM grants WHERE user_id = $1",
      [USER_ID],
    );
    expect(grants).toHaveLength(1);

    // The orphan leaf from r1 is revoked (never delivered), not reuse-detected.
    const orphan = await service.refreshAccessToken({
      refreshToken: orphanChild,
      clientId: CLIENT_ID,
    });
    if (orphan.ok) throw new Error("expected orphan revoked");
    expect(orphan.error.error_description).toMatch(/revoked/i);

    // The grace-issued token is the live leaf and rotates normally.
    const r3 = await service.refreshAccessToken({
      refreshToken: graceChild,
      clientId: CLIENT_ID,
    });
    expect(r3.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// multi-device — under flat DCR, separation comes from per-install client_id
// ---------------------------------------------------------------------------

describe("multi-device under flat DCR (per-install client_id)", () => {
  it("creates separate grants when each install uses its own client_id", async () => {
    // Each install registers as its own DCR client. Mac A and Mac B each get
    // independent client_ids, which keeps their grants separate.
    const macA = await service.registerDcrClient({
      clientName: "Sync (Mac A)",
      redirectUris: [REDIRECT_URI],
    });
    const macB = await service.registerDcrClient({
      clientName: "Sync (Mac B)",
      redirectUris: [REDIRECT_URI],
    });
    if (!macA.ok || !macB.ok) throw new Error("setup");

    const a = await happyPathAuthorize({ clientId: macA.value.client_id });
    const exA = await service.exchangeCode({
      code: a.code,
      redirectUri: REDIRECT_URI,
      codeVerifier: a.verifier,
      clientId: macA.value.client_id,
    });
    if (!exA.ok || !exA.value.refresh_token) throw new Error("setup A");

    const b = await happyPathAuthorize({ clientId: macB.value.client_id });
    const exB = await service.exchangeCode({
      code: b.code,
      redirectUri: REDIRECT_URI,
      codeVerifier: b.verifier,
      clientId: macB.value.client_id,
    });
    if (!exB.ok || !exB.value.refresh_token) throw new Error("setup B");

    const grants = await testEnv.db.query<{ oauth_client_id: string }>(
      "SELECT oauth_client_id FROM oauth_grants WHERE user_id = $1 ORDER BY oauth_client_id",
      [USER_ID],
    );
    expect(grants).toHaveLength(2);
    expect(grants.map((g) => g.oauth_client_id).sort()).toEqual(
      [macA.value.client_id, macB.value.client_id].sort(),
    );

    // Both refresh tokens still valid (Mac A is NOT kicked by Mac B login)
    const rA = await service.refreshAccessToken({
      refreshToken: exA.value.refresh_token,
      clientId: macA.value.client_id,
    });
    expect(rA.ok).toBe(true);
    const rB = await service.refreshAccessToken({
      refreshToken: exB.value.refresh_token,
      clientId: macB.value.client_id,
    });
    expect(rB.ok).toBe(true);
  });

  it("re-consent on the same client_id reuses the grant and revokes (not reuse-detects) old refresh", async () => {
    const first = await happyPathAuthorize();
    const ex1 = await service.exchangeCode({
      code: first.code,
      redirectUri: REDIRECT_URI,
      codeVerifier: first.verifier,
      clientId: CLIENT_ID,
    });
    if (!ex1.ok || !ex1.value.refresh_token) throw new Error("setup");
    const oldRefresh = ex1.value.refresh_token;

    const second = await happyPathAuthorize();
    const ex2 = await service.exchangeCode({
      code: second.code,
      redirectUri: REDIRECT_URI,
      codeVerifier: second.verifier,
      clientId: CLIENT_ID,
    });
    expect(ex2.ok).toBe(true);

    // Old refresh is revoked (revoked_at), not "reuse detected" (used_at)
    // → grant should still exist (no cascade), error should be revoked
    const r = await service.refreshAccessToken({
      refreshToken: oldRefresh,
      clientId: CLIENT_ID,
    });
    if (r.ok) throw new Error("expected error");
    expect(r.error.error).toBe("invalid_grant");
    expect(r.error.error_description).toMatch(/revoked/i);

    const grants = await testEnv.db.query(
      "SELECT id FROM grants WHERE user_id = $1",
      [USER_ID],
    );
    expect(grants).toHaveLength(1);
  });
});

describe("confidential client (client_secret_basic)", () => {
  const CONF_CLIENT = "test-confidential";
  const CONF_REDIRECT = "https://example.com/cb";
  const CONF_SECRET = "s2_secret_abcdef";

  beforeEach(async () => {
    const secretHash = await hashToken(CONF_SECRET);
    await testEnv.db.execute(
      `INSERT INTO oauth_clients (id, client_name, redirect_uris, token_endpoint_auth_method, client_secret_hash)
       VALUES ($1, 'Confidential', ARRAY[$2], 'client_secret_basic', $3)`,
      [CONF_CLIENT, CONF_REDIRECT, secretHash],
    );
  });

  async function authorize() {
    const { verifier, challenge } = await pkcePair();
    const v = await service.validateAuthorizeRequest({
      responseType: "code",
      clientId: CONF_CLIENT,
      redirectUri: CONF_REDIRECT,
      scope: "files",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    if (!v.ok) throw new Error("validate");
    const issued = await service.issueAuthorizationCode(v.value, USER_ID, {
      paths: [{ path: "", access: "read" }],
    });
    if (!issued.ok) throw new Error("issue");
    return { verifier, code: issued.value.code };
  }

  it("exchanges code with valid client_secret", async () => {
    const { verifier, code } = await authorize();
    const ex = await service.exchangeCode({
      code,
      redirectUri: CONF_REDIRECT,
      codeVerifier: verifier,
      clientId: CONF_CLIENT,
      clientSecret: CONF_SECRET,
    });
    if (!ex.ok)
      throw new Error(`exchange failed: ${ex.error.error_description}`);
    expect(ex.value.access_token).toMatch(/^s2_/);
  });

  it("rejects when client_secret missing", async () => {
    const { verifier, code } = await authorize();
    const ex = await service.exchangeCode({
      code,
      redirectUri: CONF_REDIRECT,
      codeVerifier: verifier,
      clientId: CONF_CLIENT,
    });
    if (ex.ok) throw new Error("expected error");
    expect(ex.error.error).toBe("invalid_client");
  });

  it("rejects when client_secret mismatches", async () => {
    const { verifier, code } = await authorize();
    const ex = await service.exchangeCode({
      code,
      redirectUri: CONF_REDIRECT,
      codeVerifier: verifier,
      clientId: CONF_CLIENT,
      clientSecret: "wrong-secret",
    });
    if (ex.ok) throw new Error("expected error");
    expect(ex.error.error).toBe("invalid_client");
  });
});

describe("concurrent code exchange", () => {
  it("allows only one of two concurrent /token requests for the same code", async () => {
    const { verifier, code } = await happyPathAuthorize();
    const [a, b] = await Promise.all([
      service.exchangeCode({
        code,
        redirectUri: REDIRECT_URI,
        codeVerifier: verifier,
        clientId: CLIENT_ID,
      }),
      service.exchangeCode({
        code,
        redirectUri: REDIRECT_URI,
        codeVerifier: verifier,
        clientId: CLIENT_ID,
      }),
    ]);
    const successes = [a, b].filter((r) => r.ok);
    const failures = [a, b].filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// access grant limit (shared pool: manual + delegated + OAuth)
// ---------------------------------------------------------------------------

describe("checkGrantLimit / access grant pool", () => {
  it("includes OAuth grants in countByUser", async () => {
    // Establish 1 OAuth grant via the happy path
    const { verifier, code } = await happyPathAuthorize();
    const ex = await service.exchangeCode({
      code,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      clientId: CLIENT_ID,
    });
    expect(ex.ok).toBe(true);

    const tokenRepo = new TokenRepository(testEnv.db);
    const count = await tokenRepo.countByUser(USER_ID, tx);
    expect(count).toBe(1);
  });

  it("checkGrantLimit returns willCreateNew=false on re-consent (no limit hit)", async () => {
    const { verifier, code } = await happyPathAuthorize();
    await service.exchangeCode({
      code,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      clientId: CLIENT_ID,
    });
    const check = await service.checkGrantLimit(USER_ID, CLIENT_ID);
    expect(check.willCreateNew).toBe(false);
    expect(check.exceeded).toBe(false);
  });

  async function fillManualGrants(userId: string, n: number) {
    for (let i = 0; i < n; i++) {
      await createUnissuedTestToken(testEnv.db, {
        userId,
        name: `Manual ${i}`,
      });
    }
  }

  it("checkGrantLimit reports exceeded when free user is at limit and a new client is requested", async () => {
    const freeUser = "user_oauth_limit";
    await createTestUser(testEnv.db, {
      id: freeUser,
      limits: FINITE_TEST_LIMITS,
    });
    await fillManualGrants(freeUser, 5);
    const check = await service.checkGrantLimit(freeUser, CLIENT_ID);
    expect(check.willCreateNew).toBe(true);
    expect(check.count).toBe(5);
    expect(check.limit).toBe(5);
    expect(check.exceeded).toBe(true);
  });

  it("exchangeCode rejects with access_denied when grant pool is full and client is new", async () => {
    const freeUser = "user_oauth_limit_xc";
    await createTestUser(testEnv.db, {
      id: freeUser,
      limits: FINITE_TEST_LIMITS,
    });
    await fillManualGrants(freeUser, 5);

    // Build an authorization code for the free user (bypassing the loader
    // gate, mimicking a client that races past the consent UI).
    const { verifier, challenge } = await pkcePair();
    const validated = await service.validateAuthorizeRequest({
      responseType: "code",
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: "files",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    if (!validated.ok) throw new Error("validate failed");
    const issued = await service.issueAuthorizationCode(
      validated.value,
      freeUser,
      { basePath: "/", paths: [{ path: "notes", access: "read" }] },
    );
    if (!issued.ok) throw new Error("issue failed");

    const ex = await service.exchangeCode({
      code: issued.value.code,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      clientId: CLIENT_ID,
    });
    if (ex.ok) throw new Error("expected access_denied");
    expect(ex.error.error).toBe("access_denied");
  });
});
