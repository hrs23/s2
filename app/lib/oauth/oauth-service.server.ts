// OAuthService: business logic of the OAuth 2.1 authorization server.
//
// Responsibilities:
// - validate /authorize requests
// - freeze the consent result into an authorization_code as a snapshot
// - authorization code exchange (create/update oauth_grant from the consent snapshot + issue tokens)
// - refresh token rotation (used_at = reuse detection / revoked_at = explicit revoke)
// - grant revocation / listing (for the UI)
// - DCR registration (RFC 7591) — flat DCR model
//
// HTTP / rendering is delegated to the routes layer. The service is pure operations.

import type { IQuotaService } from "~/lib/auth/quota-service.server";
import { generateS2Token, hashToken } from "~/lib/auth/token.server";
import type { TokenRepository } from "~/lib/auth/token-repository.server";
import type { DbClient } from "~/lib/db/client.server";
import { canonicalizeAccessPaths, validateBasePath } from "~/lib/files/paths";
import { newId } from "~/lib/utils/ulid.server";
import type {
  AuthorizationCodeRepository,
  ConsentPathSnapshot,
} from "./authorization-code-repository.server";
import { normalizeResource } from "./canonical-resource";
import { validateClientName, validateDcrRedirectUri } from "./dcr-validation";
import type {
  OAuthClientRepository,
  OAuthClientRow,
} from "./oauth-client-repository.server";
import type { OAuthGrantRepository } from "./oauth-grant-repository.server";
import type {
  RefreshTokenRepository,
  RefreshTokenRow,
} from "./refresh-token-repository.server";
import type {
  CodeChallengeMethod,
  OAuthError,
  OAuthScope,
  TokenResponse,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTHORIZATION_CODE_TTL_SEC = 600;
const ACCESS_TOKEN_TTL_SEC = 3600;
const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 3600;

// Rotation grace window: a refresh token re-presented within this many
// seconds of being consumed is treated as a legitimate retry (the client
// crashed / lost the response before persisting the rotated token), not a
// theft. We re-rotate from it instead of cascading the grant. Matches the
// Auth0 / Okta "rotation overlap" default. Beyond the window, reuse is
// treated as compromise (RFC 9700 §4.14).
const REFRESH_GRACE_SEC = 30;

const SUPPORTED_SCOPES: ReadonlySet<OAuthScope> = new Set(["files"]);

/**
 * Dev default resource allowlist (used when `env.ALLOWED_RESOURCES` is unset).
 * Production / staging / preview must set the env var explicitly — see
 * `parseAllowedResources` below.
 *
 * Includes localhost variants only (no production hosts) so a missing env
 * var in a deployed environment fails closed.
 */
const DEFAULT_ALLOWED_RESOURCES: ReadonlyArray<string> = [
  "http://localhost:8787/mcp",
  "http://localhost/mcp",
];

/**
 * Parse the comma-separated `ALLOWED_RESOURCES` env var into a normalized
 * set of resource indicators (RFC 8707 audience binding).
 *
 * Each entry MUST be the canonical URI of an MCP server. Empty entries
 * are rejected (strict parsing). Production env example:
 *   ALLOWED_RESOURCES = "https://s2.example.com/mcp"
 * Staging:
 *   ALLOWED_RESOURCES = "https://staging.s2.example.com/mcp"
 * Preview deploys with a custom domain add their canonical URL alongside
 * the staging one, comma-separated.
 *
 * When the env var is missing or empty, falls back to a localhost-only
 * default so `pnpm dev` works out of the box. Throws on malformed input
 * so a typo fails loudly at startup rather than silently rejecting all
 * audience-bound issuance.
 */
export function parseAllowedResources(raw: string | undefined): Set<string> {
  if (!raw || raw.trim() === "") {
    return new Set(DEFAULT_ALLOWED_RESOURCES.map((r) => normalizeResource(r)));
  }
  const out = new Set<string>();
  const parts = raw.split(",");
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === "") {
      // Reject `"a,,b"` and trailing commas — strict so misconfigurations
      // don't silently degrade.
      throw new Error(
        "ALLOWED_RESOURCES contains an empty entry; check for stray commas",
      );
    }
    out.add(normalizeResource(trimmed));
  }
  return out;
}

/**
 * DCR registration quota (abuse controls).
 * Soft global rate: max N successful registrations in the trailing window.
 * Per-IP throttling belongs at the reverse proxy; this in-code check is a
 * defense-in-depth floor.
 */
export const DCR_QUOTA_MAX_PER_WINDOW = 100;
const DCR_QUOTA_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OAuthResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: OAuthError };

/** Result for user-driven /connections page edits — not OAuth-protocol errors. */
export type GrantUpdateResult =
  | { ok: true }
  | {
      ok: false;
      error: { code: "not_found" | "invalid_request"; message: string };
    };

export interface AuthorizeRequestParams {
  responseType: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  /** RFC 8707 audience indicator. MCP passes the canonical URI. */
  resource?: string;
}

export interface ValidatedAuthorizeRequest {
  client: OAuthClientRow;
  redirectUri: string;
  scopes: OAuthScope[];
  codeChallenge: string;
  codeChallengeMethod: CodeChallengeMethod;
  state?: string;
  resource: string | null;
}

export interface ConsentDecision {
  paths: ReadonlyArray<ConsentPathSnapshot>;
  basePath?: string;
}

export interface IssuedAuthorizationCode {
  code: string;
  expiresAt: string;
}

export interface TokenExchangeRequest {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  clientId: string;
  /** Value a confidential client sent via Authorization: Basic (not allowed in the body) */
  clientSecret?: string;
  /** RFC 8707 audience indicator (token request). Must match the one used at authorize time. */
  resource?: string;
}

export interface RefreshRequest {
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
  /** RFC 8707 audience indicator (token request). Must match the original token's resource. */
  resource?: string;
}

export interface OAuthGrantSummary {
  id: string;
  client_id: string;
  client_name: string;
  base_path: string;
  paths: Array<{ path: string; access: "read" | "write" }>;
  requested_scopes: string[];
  created_at: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class OAuthService {
  private readonly allowedResources: ReadonlySet<string>;

  constructor(
    private db: DbClient,
    private userId: string,
    private clientRepo: OAuthClientRepository,
    private codeRepo: AuthorizationCodeRepository,
    private grantRepo: TokenRepository,
    private oauthGrantRepo: OAuthGrantRepository,
    private refreshRepo: RefreshTokenRepository,
    private quota: IQuotaService,
    allowedResources?: ReadonlySet<string>,
  ) {
    this.allowedResources =
      allowedResources ?? parseAllowedResources(undefined);
  }

  // -------------------------------------------------------------------------
  // Access grant limit check
  //
  // OAuth grants share the access-grant pool with manual + delegated tokens.
  // Re-consent on an existing (user, client) pair updates the same grant in
  // place, so it never crosses the limit — only fresh authorizations need to
  // honor the cap.
  // -------------------------------------------------------------------------

  async checkGrantLimit(
    userId: string,
    clientId: string,
  ): Promise<{
    count: number;
    limit: number;
    willCreateNew: boolean;
    exceeded: boolean;
  }> {
    const { existing, usage } = await this.db.withUserTx(
      this.userId,
      async (tx) => {
        const [existing, usage] = await Promise.all([
          this.oauthGrantRepo.findByUserClient(userId, clientId, tx),
          this.quota.getGrantUsage(userId, tx),
        ]);
        return { existing, usage };
      },
    );
    const willCreateNew = !existing;
    const exceeded =
      willCreateNew && usage.limit > 0 && usage.count >= usage.limit;
    return { ...usage, willCreateNew, exceeded };
  }

  // -------------------------------------------------------------------------
  // /authorize: request validation
  // -------------------------------------------------------------------------

  async validateAuthorizeRequest(
    params: AuthorizeRequestParams,
  ): Promise<OAuthResult<ValidatedAuthorizeRequest>> {
    if (params.responseType !== "code") {
      return errResult(
        "unsupported_grant_type",
        "response_type must be 'code'",
      );
    }
    if (params.codeChallengeMethod !== "S256") {
      return errResult(
        "invalid_request",
        "code_challenge_method must be 'S256'",
      );
    }
    if (!params.codeChallenge) {
      return errResult("invalid_request", "code_challenge is required");
    }

    const client = await this.clientRepo.findById(params.clientId);
    if (!client) {
      return errResult("invalid_client", "client not found");
    }

    if (!matchRedirectUri(params.redirectUri, client.redirect_uris)) {
      return errResult("invalid_request", "redirect_uri does not match");
    }

    const scopes = parseScopeString(params.scope);
    if (scopes.length === 0) {
      return errResult("invalid_scope", "scope is required");
    }
    for (const s of scopes) {
      if (!SUPPORTED_SCOPES.has(s)) {
        return errResult("invalid_scope", `unsupported scope: ${s}`);
      }
    }

    let resource: string | null = null;
    if (params.resource !== undefined && params.resource !== "") {
      // Normalize the presented value before allowlist lookup so a client
      // that sends `https://S2.EXAMPLE.COM/mcp/` matches the configured entry
      // `https://s2.example.com/mcp` (RFC 8707 §2). The normalized form is
      // what we persist on the authorization code + grant, which keeps
      // audience equality on the `/mcp` side trivial — both sides use the
      // same canonicalization rule.
      const normalized = normalizeResource(params.resource);
      if (!this.allowedResources.has(normalized)) {
        return errResult(
          "invalid_target",
          `unsupported resource: ${params.resource}`,
        );
      }
      resource = normalized;
    }

    return {
      ok: true,
      value: {
        client,
        redirectUri: params.redirectUri,
        scopes,
        codeChallenge: params.codeChallenge,
        codeChallengeMethod: "S256",
        state: params.state,
        resource,
      },
    };
  }

  // -------------------------------------------------------------------------
  // consent → issue authorization code (freeze consent snapshot into the code)
  // -------------------------------------------------------------------------

  async issueAuthorizationCode(
    request: ValidatedAuthorizeRequest,
    userId: string,
    consent: ConsentDecision,
  ): Promise<OAuthResult<IssuedAuthorizationCode>> {
    if (consent.paths.length === 0) {
      return errResult("access_denied", "user denied or no paths granted");
    }
    const canonicalized = canonicalizeAccessPaths(consent.paths, {
      duplicateMessage: (c) => `duplicate consent path: "${c}"`,
    });
    if (!canonicalized.ok) {
      return errResult("invalid_request", canonicalized.error);
    }
    const consentPaths: ConsentPathSnapshot[] = canonicalized.paths;

    const code = generateS2Token();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + AUTHORIZATION_CODE_TTL_SEC * 1000,
    ).toISOString();

    await this.codeRepo.create({
      code,
      clientId: request.client.id,
      userId,
      redirectUri: request.redirectUri,
      scopes: request.scopes,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: request.codeChallengeMethod,
      basePath: consent.basePath ?? "/",
      consentPaths,
      resource: request.resource,
      expiresAt,
    });

    return { ok: true, value: { code, expiresAt } };
  }

  // -------------------------------------------------------------------------
  // /token: authorization code → access_token + refresh_token
  // -------------------------------------------------------------------------

  async exchangeCode(
    req: TokenExchangeRequest,
  ): Promise<OAuthResult<TokenResponse>> {
    const codeRow = await this.codeRepo.consume(req.code);
    if (!codeRow) {
      return errResult("invalid_grant", "code not found, used, or expired");
    }

    if (codeRow.client_id !== req.clientId) {
      return errResult("invalid_grant", "client mismatch");
    }
    if (codeRow.redirect_uri !== req.redirectUri) {
      return errResult("invalid_grant", "redirect_uri mismatch");
    }

    const computed = await pkceTransform(req.codeVerifier);
    if (computed !== codeRow.code_challenge) {
      return errResult("invalid_grant", "PKCE verification failed");
    }

    if (req.resource !== undefined && req.resource !== "") {
      if (req.resource !== codeRow.resource) {
        return errResult(
          "invalid_target",
          "resource does not match authorization request",
        );
      }
    }

    const clientCheck = await this.authenticateClient(
      req.clientId,
      req.clientSecret,
    );
    if (!clientCheck.ok) return clientCheck;

    const accessTokenPlain = generateS2Token();
    const refreshTokenPlain = generateS2Token();
    const accessHash = await hashToken(accessTokenPlain);
    const refreshHash = await hashToken(refreshTokenPlain);
    const now = new Date();
    const accessExpires = new Date(
      now.getTime() + ACCESS_TOKEN_TTL_SEC * 1000,
    ).toISOString();
    const refreshExpires = new Date(
      now.getTime() + REFRESH_TOKEN_TTL_SEC * 1000,
    ).toISOString();
    const refreshTokenId = newId("rt_");

    // The consent screen turns away over-limit users up front; this is the
    // defense-in-depth check for clients that race past the UI or bypass it.
    let limitErr: { limit: number } | null = null;

    // Token endpoint flow: user identity comes from the consumed code row,
    // not from this.userId (createServices is invoked with "" here because
    // /oauth/token is unauthenticated).
    await this.db.withUserWriteTx(codeRow.user_id, async (tx) => {
      const existing = await this.oauthGrantRepo.findByUserClient(
        codeRow.user_id,
        codeRow.client_id,
        tx,
      );

      if (!existing) {
        const usage = await this.quota.getGrantUsage(codeRow.user_id, tx);
        if (usage.limit > 0 && usage.count >= usage.limit) {
          limitErr = { limit: usage.limit };
          return;
        }
      }

      let grantId: string;
      if (existing) {
        grantId = existing.grant_id;
        // Re-consent: replace base_path / paths and the oauth_grants snapshot
        // columns (scopes / resource) with the new snapshot.
        // client_id is part of the grant identity, so it is immutable.
        await this.grantRepo.updateBasePath(grantId, codeRow.base_path, tx);
        await this.grantRepo.replaceAccessPaths(
          grantId,
          codeRow.consent_paths.map((p) => ({
            path: p.path,
            access: p.access,
          })),
          tx,
        );
        await this.oauthGrantRepo.updateOnReconsent(
          grantId,
          {
            oauthRequestedScopes: codeRow.scopes,
            resource: codeRow.resource,
          },
          tx,
        );
        // Invalidate old active refresh_tokens via revoked_at (leave used_at
        // untouched to distinguish from reuse detection)
        await this.refreshRepo.revokeAllForGrant(grantId, "reconsent", tx);
      } else {
        grantId = newId("grt_");
        await this.oauthGrantRepo.create(
          {
            grantId,
            userId: codeRow.user_id,
            basePath: codeRow.base_path,
            createdAt: now.toISOString(),
            oauthClientId: codeRow.client_id,
            oauthRequestedScopes: codeRow.scopes,
            resource: codeRow.resource,
          },
          tx,
        );
        await this.grantRepo.createAccessPaths(
          grantId,
          codeRow.consent_paths.map((p) => ({
            path: p.path,
            access: p.access,
          })),
          tx,
        );
      }

      await this.grantRepo.writeSecret(grantId, accessHash, accessExpires, tx);
      await this.refreshRepo.insert(
        {
          id: refreshTokenId,
          grantId,
          tokenHash: refreshHash,
          expiresAt: refreshExpires,
        },
        tx,
      );
    });

    if (limitErr !== null) {
      const { limit } = limitErr;
      return errResult(
        "access_denied",
        `Access grant limit reached (${limit}).`,
      );
    }

    return {
      ok: true,
      value: {
        access_token: accessTokenPlain,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SEC,
        refresh_token: refreshTokenPlain,
        scope: codeRow.scopes.join(" "),
      },
    };
  }

  // -------------------------------------------------------------------------
  // /token: refresh_token → new access_token + new refresh_token
  // (rotation + reuse detection)
  // -------------------------------------------------------------------------

  async refreshAccessToken(
    req: RefreshRequest,
  ): Promise<OAuthResult<TokenResponse>> {
    const clientCheck = await this.authenticateClient(
      req.clientId,
      req.clientSecret,
    );
    if (!clientCheck.ok) return clientCheck;

    const presentedHash = await hashToken(req.refreshToken);
    const row = await this.refreshRepo.findByHash(presentedHash);

    if (!row) {
      return errResult("invalid_grant", "refresh token not found");
    }

    // From explicit revoke / re-consent: return invalid_grant without cascading
    if (row.revoked_at !== null) {
      return errResult(
        "invalid_grant",
        `refresh token revoked (${row.revocation_reason ?? "unknown"})`,
      );
    }

    // A consumed token was presented again. Inside the grace window this is a normal retry
    // (the client crashed or missed the response before persisting the rotated token), so rotate again.
    // Outside the window it signals theft → cascade-revoke the grant (RFC 9700 §4.14).
    if (row.used_at !== null) {
      const usedAgeSec = (Date.now() - new Date(row.used_at).getTime()) / 1000;
      if (usedAgeSec > REFRESH_GRACE_SEC) {
        await this.db.withUserWriteTx(row.user_id, async (tx) =>
          this.grantRepo.deleteToken(row.grant_id, tx),
        );
        return errResult(
          "invalid_grant",
          "refresh token reuse detected; grant revoked",
        );
      }
      return this.rotateWithinGrace(row);
    }

    if (new Date(row.expires_at).getTime() < Date.now()) {
      return errResult("invalid_grant", "refresh token expired");
    }

    // resource comes from the original token's grant (oauth_grants is the source of truth).
    // refresh_tokens denormalizes user_id, so open withUserTx from it
    // to read oauth_grants (RLS).
    const grant = await this.db.withUserTx(row.user_id, async (tx) =>
      this.oauthGrantRepo.findById(row.grant_id, tx),
    );
    if (!grant) {
      return errResult("invalid_grant", "grant not found");
    }

    // RFC 6749 §10.4 / RFC 9700 §2.2.2 + §4.13: refresh_token is bound to the
    // client it was issued to. A wrong-client presentation is a separate
    // failure mode from token theft (reuse), so we do NOT consume used_at and
    // do NOT trigger the family cascade revoke.
    if (grant.oauth_client_id !== req.clientId) {
      return errResult("invalid_grant", "client mismatch");
    }

    if (req.resource !== undefined && req.resource !== "") {
      if (req.resource !== grant.resource) {
        return errResult(
          "invalid_target",
          "resource does not match original audience",
        );
      }
    }

    const accessTokenPlain = generateS2Token();
    const refreshTokenPlain = generateS2Token();
    const accessHash = await hashToken(accessTokenPlain);
    const refreshHash = await hashToken(refreshTokenPlain);
    const now = new Date();
    const accessExpires = new Date(
      now.getTime() + ACCESS_TOKEN_TTL_SEC * 1000,
    ).toISOString();
    const refreshExpires = new Date(
      now.getTime() + REFRESH_TOKEN_TTL_SEC * 1000,
    ).toISOString();
    const newRefreshId = newId("rt_");

    let grantId: string | null = null;
    // Token endpoint flow: user identity comes from the refresh_tokens row.
    await this.db.withUserWriteTx(row.user_id, async (tx) => {
      const consumed = await this.refreshRepo.consume(row.id, tx);
      if (!consumed) {
        return;
      }
      grantId = consumed.grant_id;
      await this.refreshRepo.insert(
        {
          id: newRefreshId,
          grantId: consumed.grant_id,
          tokenHash: refreshHash,
          expiresAt: refreshExpires,
        },
        tx,
      );
      await this.grantRepo.writeSecret(
        consumed.grant_id,
        accessHash,
        accessExpires,
        tx,
      );
    });

    if (grantId === null) {
      // consume() failed = the row moved on from the active state we saw.
      // Re-fetch to find out why: if revoked_at is set, a re-consent / explicit
      // revoke in another tx simply interleaved (no cascade). If used_at is set, it is a
      // real concurrent rotation or reuse → cascade the grant.
      const recheck = await this.refreshRepo.findByHash(presentedHash);
      if (recheck?.revoked_at !== null && recheck?.revoked_at !== undefined) {
        return errResult(
          "invalid_grant",
          `refresh token revoked (${recheck.revocation_reason ?? "unknown"})`,
        );
      }
      await this.db.withUserWriteTx(row.user_id, async (tx) =>
        this.grantRepo.deleteToken(row.grant_id, tx),
      );
      return errResult(
        "invalid_grant",
        "concurrent refresh detected; grant revoked",
      );
    }

    return {
      ok: true,
      value: {
        access_token: accessTokenPlain,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SEC,
        refresh_token: refreshTokenPlain,
      },
    };
  }

  /**
   * Re-rotate from a refresh token that was consumed within the grace window.
   * The active leaf produced by the first rotation never reached the client
   * (otherwise it wouldn't be re-presenting the old token), so we revoke that
   * orphan leaf and mint a fresh pair from the same grant. No cascade — this
   * is a legitimate retry, not a compromise.
   */
  private async rotateWithinGrace(
    row: RefreshTokenRow,
  ): Promise<OAuthResult<TokenResponse>> {
    const accessTokenPlain = generateS2Token();
    const refreshTokenPlain = generateS2Token();
    const accessHash = await hashToken(accessTokenPlain);
    const refreshHash = await hashToken(refreshTokenPlain);
    const now = new Date();
    const accessExpires = new Date(
      now.getTime() + ACCESS_TOKEN_TTL_SEC * 1000,
    ).toISOString();
    const refreshExpires = new Date(
      now.getTime() + REFRESH_TOKEN_TTL_SEC * 1000,
    ).toISOString();
    const newRefreshId = newId("rt_");

    await this.db.withUserWriteTx(row.user_id, async (tx) => {
      // Free the partial-unique active slot before inserting the new leaf.
      // "reconsent" is the only revocation_reason; here it means "old leaf
      // superseded by a fresh issuance" and stays internal.
      await this.refreshRepo.revokeAllForGrant(row.grant_id, "reconsent", tx);
      await this.refreshRepo.insert(
        {
          id: newRefreshId,
          grantId: row.grant_id,
          tokenHash: refreshHash,
          expiresAt: refreshExpires,
        },
        tx,
      );
      await this.grantRepo.writeSecret(
        row.grant_id,
        accessHash,
        accessExpires,
        tx,
      );
    });

    return {
      ok: true,
      value: {
        access_token: accessTokenPlain,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SEC,
        refresh_token: refreshTokenPlain,
      },
    };
  }

  // -------------------------------------------------------------------------
  // OAuth grants list / revoke (used by the UI)
  // -------------------------------------------------------------------------

  async listGrantsForUser(userId: string): Promise<OAuthGrantSummary[]> {
    const rows = await this.db.withUserTx(this.userId, (tx) =>
      tx.query<{
        id: string;
        client_id: string;
        client_name: string;
        base_path: string;
        requested_scopes: string[];
        created_at: string;
        path: string | null;
        access: string | null;
      }>(
        `SELECT g.id,
                og.oauth_client_id AS client_id,
                c.client_name,
                g.base_path,
                og.oauth_requested_scopes AS requested_scopes,
                g.created_at,
                p.path, p.access
         FROM grants g
         JOIN oauth_grants og ON og.grant_id = g.id
         JOIN oauth_clients c ON c.id = og.oauth_client_id
         LEFT JOIN grant_paths p ON p.grant_id = g.id
         WHERE g.user_id = $1
         ORDER BY g.created_at DESC, g.id DESC, p.path ASC`,
        [userId],
      ),
    );

    const map = new Map<string, OAuthGrantSummary>();
    for (const row of rows) {
      if (!map.has(row.id)) {
        map.set(row.id, {
          id: row.id,
          client_id: row.client_id,
          client_name: row.client_name,
          base_path: row.base_path,
          paths: [],
          requested_scopes: row.requested_scopes ?? [],
          created_at: row.created_at,
        });
      }
      if (row.path !== null && row.access !== null) {
        map.get(row.id)?.paths.push({
          path: row.path,
          access: row.access === "write" ? "write" : "read",
        });
      }
    }
    return Array.from(map.values());
  }

  /** Disconnect a single OAuth grant. */
  async revokeGrantOwned(grantId: string, userId: string): Promise<boolean> {
    return this.db.withUserWriteTx(this.userId, async (tx) => {
      const owned = await tx.queryOne<{ id: string }>(
        `SELECT g.id
         FROM grants g
         JOIN oauth_grants og ON og.grant_id = g.id
         WHERE g.id = $1 AND g.user_id = $2`,
        [grantId, userId],
      );
      if (!owned) return false;
      await this.grantRepo.deleteToken(grantId, tx);
      return true;
    });
  }

  /**
   * Update an OAuth grant's base_path and access paths from the
   * Connections page. Existing access_token / refresh_token remain valid;
   * the new scope takes effect on the next request because paths are
   * looked up per-request from grant_paths.
   */
  async updateGrantOwned(
    grantId: string,
    userId: string,
    input: {
      basePath: string;
      paths: ReadonlyArray<{ path: string; access: "read" | "write" }>;
    },
  ): Promise<GrantUpdateResult> {
    const basePathErr = validateBasePath(input.basePath);
    if (basePathErr) {
      return {
        ok: false,
        error: { code: "invalid_request", message: basePathErr },
      };
    }
    if (input.paths.length === 0) {
      return {
        ok: false,
        error: {
          code: "invalid_request",
          message: "at least one path required",
        },
      };
    }
    const canonicalized = canonicalizeAccessPaths(input.paths, {
      duplicateMessage: () => "duplicate paths",
    });
    if (!canonicalized.ok) {
      return {
        ok: false,
        error: { code: "invalid_request", message: canonicalized.error },
      };
    }
    const canonicalPaths = canonicalized.paths;

    return this.db.withUserWriteTx(
      this.userId,
      async (tx): Promise<GrantUpdateResult> => {
        const locked = await tx.queryOne<{ id: string }>(
          `SELECT g.id
         FROM grants g
         JOIN oauth_grants og ON og.grant_id = g.id
         WHERE g.id = $1 AND g.user_id = $2
         FOR UPDATE OF g`,
          [grantId, userId],
        );
        if (!locked) {
          return {
            ok: false,
            error: { code: "not_found", message: "grant not found" },
          };
        }
        await this.grantRepo.updateToken(
          grantId,
          { basePath: input.basePath },
          tx,
        );
        await this.grantRepo.replaceAccessPaths(grantId, canonicalPaths, tx);
        return { ok: true };
      },
    );
  }

  // -------------------------------------------------------------------------
  // DCR: POST /oauth/register (RFC 7591)
  //
  // Flat DCR — no first-party / third-party distinction. Every client
  // registers dynamically. Abuse controls live in this function:
  //   - client_name validation (length / charset / reserved words)
  //   - redirect_uri allowlist (loopback http or https)
  //   - registration quota (global, in trailing window)
  // -------------------------------------------------------------------------

  async registerDcrClient(params: {
    clientName: string;
    redirectUris: ReadonlyArray<string>;
    tokenEndpointAuthMethod?: "none" | "client_secret_basic";
    metadata?: Record<string, unknown>;
  }): Promise<
    OAuthResult<{
      client_id: string;
      client_secret?: string;
    }>
  > {
    const nameErr = validateClientName(params.clientName);
    if (nameErr) {
      return errResult("invalid_client_metadata", nameErr);
    }

    if (params.redirectUris.length === 0) {
      return errResult("invalid_redirect_uri", "redirect_uris is required");
    }
    for (const uri of params.redirectUris) {
      const err = validateDcrRedirectUri(uri);
      if (err) {
        return errResult("invalid_redirect_uri", err);
      }
    }

    const recent =
      await this.clientRepo.countRecentRegistrations(DCR_QUOTA_WINDOW_MS);
    if (recent >= DCR_QUOTA_MAX_PER_WINDOW) {
      return errResult(
        "too_many_requests",
        "registration rate limit exceeded; try again later",
      );
    }

    const authMethod = params.tokenEndpointAuthMethod ?? "none";
    const clientId = `${newId("dcr_")}${newId()}`;

    let clientSecretPlain: string | undefined;
    let clientSecretHash: string | null = null;
    if (authMethod === "client_secret_basic") {
      clientSecretPlain = generateS2Token();
      clientSecretHash = await hashToken(clientSecretPlain);
    }

    await this.clientRepo.registerDcr({
      id: clientId,
      clientName: params.clientName.trim(),
      redirectUris: params.redirectUris,
      tokenEndpointAuthMethod: authMethod,
      clientSecretHash,
      metadata: params.metadata,
    });

    return {
      ok: true,
      value: {
        client_id: clientId,
        ...(clientSecretPlain ? { client_secret: clientSecretPlain } : {}),
      },
    };
  }

  // -------------------------------------------------------------------------
  // For /mcp: verify access_token + validate audience
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async authenticateClient(
    clientId: string,
    clientSecret: string | undefined,
  ): Promise<OAuthResult<true>> {
    const client = await this.clientRepo.findById(clientId);
    if (!client) return errResult("invalid_client", "client not found");

    if (client.token_endpoint_auth_method === "none") {
      if (clientSecret !== undefined) {
        return errResult(
          "invalid_client",
          "public client must not present client_secret",
        );
      }
      return { ok: true, value: true };
    }

    if (!clientSecret) {
      return errResult("invalid_client", "client_secret required");
    }
    if (!client.client_secret_hash) {
      return errResult("server_error", "client missing secret hash");
    }
    const presentedHash = await hashToken(clientSecret);
    if (presentedHash !== client.client_secret_hash) {
      return errResult("invalid_client", "client_secret mismatch");
    }
    return { ok: true, value: true };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errResult(
  code: OAuthError["error"],
  description: string,
): OAuthResult<never> {
  return { ok: false, error: { error: code, error_description: description } };
}

function parseScopeString(scope: string): OAuthScope[] {
  return scope.split(/\s+/).filter((s) => s.length > 0) as OAuthScope[];
}

/**
 * Loopback redirect special case: the port may differ if scheme + host + path match
 * (RFC 8252 §7.3).
 */
function matchRedirectUri(presented: string, registered: string[]): boolean {
  let presentedUrl: URL;
  try {
    presentedUrl = new URL(presented);
  } catch {
    return false;
  }

  for (const reg of registered) {
    let regUrl: URL;
    try {
      regUrl = new URL(reg);
    } catch {
      continue;
    }

    if (regUrl.hostname === "127.0.0.1" || regUrl.hostname === "localhost") {
      if (
        presentedUrl.protocol === regUrl.protocol &&
        presentedUrl.hostname === regUrl.hostname &&
        presentedUrl.pathname === regUrl.pathname
      ) {
        return true;
      }
    } else {
      if (presented === reg) return true;
    }
  }
  return false;
}

/** PKCE S256: base64url(SHA-256(code_verifier)) */
async function pkceTransform(codeVerifier: string): Promise<string> {
  const data = new TextEncoder().encode(codeVerifier);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(buf));
}

function base64UrlEncode(buf: Uint8Array): string {
  let str = "";
  for (const b of buf) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
