// TokenService: business logic for API token management.
// Quota checks go through QuotaService so manual + delegated + OAuth
// grants share a single quota pool.

import type { AccessPath } from "~/lib/api";
import type { DbClient } from "~/lib/db/client.server";
import { canonicalizeAccessPaths } from "~/lib/files/paths";
import { generateUlidForApi } from "~/lib/utils/ulid.server";
import type { AuthContext } from "./auth.server";
import { assertServiceUserMatches } from "./auth-assertions.server";
import type { IAuthorizationService } from "./authorization-service.server";
import type { IQuotaService } from "./quota-service.server";
import { generateS2Token, hashToken } from "./token.server";
import {
  TokenHasChildrenError,
  type TokenRepository,
  type UpdatedTokenRow,
} from "./token-repository.server";
import type { AccessLevel, AccessPathRow } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_EXPIRES_DAYS = 90;
const MAX_EXPIRES_DAYS = 365;

const TOKEN_NOT_FOUND_ERROR = {
  ok: false,
  code: "not_found",
  message: "Token not found",
} as const;

type InvalidInputError = {
  ok: false;
  code: "invalid_input";
  message: string;
};

function validateBasePathSlashAndDotDot(
  basePath: string,
): InvalidInputError | null {
  if (!basePath.startsWith("/")) {
    return {
      ok: false,
      code: "invalid_input",
      message: "base_path must start with /",
    };
  }
  if (basePath.includes("..")) {
    return {
      ok: false,
      code: "invalid_input",
      message: "base_path must not contain ..",
    };
  }
  return null;
}

function validateNonEmptyAccessPathsArray(
  paths: unknown,
): InvalidInputError | null {
  if (!Array.isArray(paths)) {
    return {
      ok: false,
      code: "invalid_input",
      message: "access_paths must be an array",
    };
  }
  if (paths.length === 0) {
    return {
      ok: false,
      code: "invalid_input",
      message: "access_paths must contain at least one entry",
    };
  }
  return null;
}

function validateExpiresInDays(
  value: number | undefined,
): { days: number; error: null } | { days: null; error: InvalidInputError } {
  if (value === undefined) {
    return { days: DEFAULT_EXPIRES_DAYS, error: null };
  }
  if (!Number.isInteger(value) || value < 1) {
    return {
      days: null,
      error: {
        ok: false,
        code: "invalid_input",
        message: "expires_in_days must be a positive integer",
      },
    };
  }
  if (value > MAX_EXPIRES_DAYS) {
    return {
      days: null,
      error: {
        ok: false,
        code: "invalid_input",
        message: `expires_in_days must be at most ${MAX_EXPIRES_DAYS}`,
      },
    };
  }
  return { days: value, error: null };
}

// ---------------------------------------------------------------------------
// Result types (ok/error pattern matching FileService)
// ---------------------------------------------------------------------------

export type TokenResult<T, E extends string> =
  | ({ ok: true } & T)
  | { ok: false; code: E; message: string };

// ---------------------------------------------------------------------------
// Create params / return types
// ---------------------------------------------------------------------------

export interface CreateTokenParams {
  name: string;
  base_path?: string;
  can_delegate?: boolean;
  expires_in_days?: number;
  access_paths: Array<{
    path: string;
    access?: AccessLevel;
  }>;
}

interface CreatedToken {
  id: string;
  name: string;
  base_path: string;
  can_delegate: boolean;
  origin_id: string | null;
  created_at: string;
  access_paths: AccessPath[];
}

export interface CreateTokenResult {
  token: CreatedToken;
  raw_token: string;
  expires_at: string;
}

interface TokenListItem {
  id: string;
  name: string;
  base_path: string;
  can_delegate: boolean;
  origin_id: string | null;
  created_at: string;
  access_paths: AccessPath[];
  /**
   * True iff the token row currently holds a usable secret (hash set + not
   * expired at DB-level; revoked → false). Drives the UI split between
   * "issue" (first time) and "rotate" (replace existing).
   */
  has_active_secret: boolean;
  token_expires_at: string | null;
}

export interface TokenListResult {
  tokens: TokenListItem[];
  grant_count: number;
  grant_limit: number;
}

export interface IssuedToken {
  token: string;
  expires_at: string;
}

export interface UpdateTokenParams {
  name?: string;
  base_path?: string;
  can_delegate?: boolean;
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export type CreateErrorCode =
  | "limit_reached"
  | "invalid_input"
  | "no_delegate_permission"
  | "scope_violation";

export type GetErrorCode = "not_found";
export type UpdateErrorCode = "not_found" | "invalid_input";
export type DeleteErrorCode = "not_found" | "forbidden" | "has_children";
export type IssueErrorCode = "not_found" | "invalid_input" | "conflict";
export type RotateErrorCode = "not_found" | "invalid_input" | "conflict";
export type RevokeErrorCode = "not_found";
export type ReplaceAccessPathsErrorCode = "not_found" | "invalid_input";

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TokenService {
  constructor(
    private tokenRepo: TokenRepository,
    private db: DbClient,
    private userId: string,
    private authz: IAuthorizationService,
    private quota: IQuotaService,
  ) {}

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  async create(
    auth: AuthContext,
    params: CreateTokenParams,
  ): Promise<TokenResult<CreateTokenResult, CreateErrorCode>> {
    assertServiceUserMatches(auth, this.userId);
    // Validate name
    if (typeof params.name !== "string" || !params.name.trim()) {
      return { ok: false, code: "invalid_input", message: "name is required" };
    }
    const name = params.name.trim();

    // Validate base_path
    const rawBasePath = params.base_path ?? "/";
    if (typeof rawBasePath !== "string") {
      return {
        ok: false,
        code: "invalid_input",
        message: "base_path must be a string",
      };
    }
    const basePath = rawBasePath;
    const basePathError = validateBasePathSlashAndDotDot(basePath);
    if (basePathError) return basePathError;

    // Validate access_paths. A token without any access_paths can authenticate
    // but has no scope, so every file/WebDAV request returns 403. Reject to
    // mirror oauth-service.issueAuthorizationCode and updateGrantOwned.
    const accessPathsArrayError = validateNonEmptyAccessPathsArray(
      params.access_paths,
    );
    if (accessPathsArrayError) return accessPathsArrayError;
    const canonicalized = canonicalizeAccessPaths(params.access_paths, {
      checkAccess: true,
      duplicateMessage: (c) => `duplicate access_paths[].path: "${c}"`,
    });
    if (!canonicalized.ok) {
      return { ok: false, code: "invalid_input", message: canonicalized.error };
    }
    const canonicalAccessPaths: AccessPath[] = canonicalized.paths;

    const canDelegate = !!params.can_delegate;

    // Delegation validation for token auth
    if (auth.type === "token") {
      if (!auth.can_delegate) {
        return {
          ok: false,
          code: "no_delegate_permission",
          message: "No delegate permission",
        };
      }

      const result = this.authz.validateDelegation(
        auth,
        basePath,
        canonicalAccessPaths,
      );
      if (!result.valid) {
        return {
          ok: false,
          code: "scope_violation",
          message: result.reason ?? "scope_violation",
        };
      }
    }

    const expiresResult = validateExpiresInDays(params.expires_in_days);
    if (expiresResult.error) return expiresResult.error;
    const days = expiresResult.days;

    const tokenId = generateUlidForApi();
    const now = new Date().toISOString();
    const originId = auth.type === "token" ? auth.token_id : null;
    const accessPaths = canonicalAccessPaths;

    // Generate raw token and hash (auto-issue)
    const s2Token = generateS2Token();
    const tokenHash = await hashToken(s2Token);
    const expiresAt = new Date(Date.now() + days * 86400_000).toISOString();

    const limitErr = await this.db.withUserWriteTx(this.userId, async (tx) => {
      const usage = await this.quota.getGrantUsage(auth.user_id, tx);
      if (usage.limit > 0 && usage.count >= usage.limit) {
        return { limit: usage.limit };
      }
      await this.tokenRepo.createToken(
        {
          id: tokenId,
          userId: auth.user_id,
          name,
          basePath,
          canDelegate,
          originId,
          createdAt: now,
        },
        tx,
      );
      await this.tokenRepo.createAccessPaths(
        tokenId,
        accessPaths.map((p) => ({
          path: p.path,
          access: p.access ?? "write",
        })),
        tx,
      );
      await this.tokenRepo.writeSecret(tokenId, tokenHash, expiresAt, tx);
      return null;
    });

    if (limitErr) {
      return {
        ok: false,
        code: "limit_reached",
        message: `Access grant limit reached (${limitErr.limit}). Revoke an existing one to create more.`,
      };
    }

    return {
      ok: true,
      token: {
        id: tokenId,
        name,
        base_path: basePath,
        can_delegate: canDelegate,
        origin_id: originId,
        created_at: now,
        access_paths: accessPaths.map((p) => ({
          path: p.path,
          access: p.access ?? "write",
        })),
      },
      raw_token: s2Token,
      expires_at: expiresAt,
    };
  }

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------

  async list(userId: string): Promise<TokenListResult> {
    const { rows, usage } = await this.db.withUserTx(
      this.userId,
      async (tx) => {
        const rows = await this.tokenRepo.listWithPathsByUser(userId, tx);
        const usage = await this.quota.getGrantUsage(userId, tx);
        return { rows, usage };
      },
    );

    // Group flat JOIN rows by token id
    const map = new Map<string, TokenListItem>();
    for (const row of rows) {
      if (!map.has(row.id)) {
        // listWithPathsByUser filters origin IN ('manual', 'delegated'),
        // and the CHECK constraint guarantees name IS NOT NULL for those.
        map.set(row.id, {
          id: row.id,
          name: row.name ?? "",
          base_path: row.base_path,
          can_delegate: row.token_can_delegate,
          origin_id: row.origin_id,
          created_at: row.created_at,
          access_paths: [],
          has_active_secret: row.token_expires_at !== null,
          token_expires_at: row.token_expires_at,
        });
      }
      if (row.path !== null) {
        map.get(row.id)?.access_paths.push({
          path: row.path,
          access: (row.access as AccessLevel) ?? "write",
        });
      }
    }

    return {
      tokens: Array.from(map.values()),
      grant_count: usage.count,
      grant_limit: usage.limit,
    };
  }

  // -------------------------------------------------------------------------
  // Get
  // -------------------------------------------------------------------------

  async get(
    userId: string,
    tokenId: string,
  ): Promise<TokenResult<{ token: UpdatedTokenRow }, GetErrorCode>> {
    const detail = await this.db.withUserTx(this.userId, async (tx) => {
      const token = await this.tokenRepo.getOwnedToken(tokenId, userId, tx);
      if (!token) return null;
      return this.tokenRepo.getOwnedTokenDetail(tokenId, userId, tx);
    });
    if (!detail) {
      return TOKEN_NOT_FOUND_ERROR;
    }

    return {
      ok: true,
      token: {
        id: detail.id,
        name: detail.name,
        base_path: detail.base_path,
        can_delegate: false, // minimal — caller can use list() for full info
      },
    };
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  async update(
    userId: string,
    tokenId: string,
    updates: UpdateTokenParams,
  ): Promise<TokenResult<{ token: UpdatedTokenRow }, UpdateErrorCode>> {
    // Validate inputs
    const repoUpdates: {
      name?: string;
      basePath?: string;
      canDelegate?: boolean;
    } = {};
    let hasUpdates = false;

    if (typeof updates.name === "string" && updates.name.trim()) {
      repoUpdates.name = updates.name.trim();
      hasUpdates = true;
    }

    if (typeof updates.base_path === "string") {
      const basePathError = validateBasePathSlashAndDotDot(updates.base_path);
      if (basePathError) return basePathError;
      repoUpdates.basePath = updates.base_path;
      hasUpdates = true;
    }

    if (typeof updates.can_delegate === "boolean") {
      repoUpdates.canDelegate = updates.can_delegate;
      hasUpdates = true;
    }

    if (!hasUpdates) {
      return {
        ok: false,
        code: "invalid_input",
        message: "Specify at least one of name, base_path, or can_delegate",
      };
    }

    const updated = await this.db.withUserWriteTx(this.userId, async (tx) => {
      // Verify ownership inside the same tx as the update so RLS applies
      // consistently.
      const existing = await this.tokenRepo.getOwnedToken(tokenId, userId, tx);
      if (!existing) return null;
      return this.tokenRepo.updateToken(tokenId, repoUpdates, tx);
    });
    if (!updated) {
      return TOKEN_NOT_FOUND_ERROR;
    }

    return { ok: true, token: updated };
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  async delete(
    auth: AuthContext,
    tokenId: string,
  ): Promise<TokenResult<object, DeleteErrorCode>> {
    assertServiceUserMatches(auth, this.userId);
    if (auth.type === "user") {
      // User auth: can delete any of their own tokens
      try {
        const found = await this.db.withUserWriteTx(this.userId, async (tx) => {
          const existing = await this.tokenRepo.getOwnedToken(
            tokenId,
            auth.user_id,
            tx,
          );
          if (!existing) return false;
          await this.tokenRepo.deleteToken(tokenId, tx);
          return true;
        });
        if (!found) {
          return TOKEN_NOT_FOUND_ERROR;
        }
      } catch (e) {
        if (e instanceof TokenHasChildrenError) {
          return {
            ok: false,
            code: "has_children",
            message:
              "Token has delegation children; delete or detach them first",
          };
        }
        throw e;
      }
      return { ok: true };
    }

    // Token auth: can only delete direct children (origin_id === auth.token_id)
    const result = await this.db
      .withUserWriteTx(this.userId, async (tx) => {
        const row = await this.tokenRepo.getTokenOrigin(
          tokenId,
          auth.user_id,
          tx,
        );
        if (!row) {
          return { ok: false as const, code: "not_found" as const };
        }
        if (row.origin_id === null || row.origin_id !== auth.token_id) {
          return { ok: false as const, code: "forbidden" as const };
        }
        await this.tokenRepo.deleteToken(tokenId, tx);
        return { ok: true as const };
      })
      .catch((e: unknown) => {
        if (e instanceof TokenHasChildrenError) {
          return { ok: false as const, code: "has_children" as const };
        }
        throw e;
      });

    if (!result.ok) {
      const messages: Record<DeleteErrorCode, string> = {
        not_found: "Token not found",
        forbidden: "Can only delete tokens you created via delegation",
        has_children:
          "Token has delegation children; delete or detach them first",
      };
      return { ok: false, code: result.code, message: messages[result.code] };
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Issue / Rotate (generate raw secret and store hash)
  //
  // Split for explicit UX:
  //   - issue:  first-time secret (409 conflict if already issued)
  //   - rotate: replace existing secret (409 conflict if never issued)
  // Both share a private writer; callers pick the verb that matches intent.
  // -------------------------------------------------------------------------

  async issue(
    userId: string,
    tokenId: string,
    expiresInDays?: number,
  ): Promise<TokenResult<{ issued: IssuedToken }, IssueErrorCode>> {
    return this.issueOrRotate(userId, tokenId, expiresInDays, "issue");
  }

  async rotate(
    userId: string,
    tokenId: string,
    expiresInDays?: number,
  ): Promise<TokenResult<{ issued: IssuedToken }, RotateErrorCode>> {
    return this.issueOrRotate(userId, tokenId, expiresInDays, "rotate");
  }

  private async issueOrRotate(
    userId: string,
    tokenId: string,
    expiresInDays: number | undefined,
    mode: "issue" | "rotate",
  ): Promise<TokenResult<{ issued: IssuedToken }, IssueErrorCode>> {
    const expiresResult = validateExpiresInDays(expiresInDays);
    if (expiresResult.error) return expiresResult.error;
    const days = expiresResult.days;

    const s2Token = generateS2Token();
    const tokenHash = await hashToken(s2Token);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + days * 86400_000).toISOString();

    const result = await this.db.withUserWriteTx(this.userId, async (tx) => {
      const existing = await this.tokenRepo.getOwnedToken(tokenId, userId, tx);
      if (!existing) {
        return { ok: false as const, code: "not_found" as const };
      }
      if (mode === "issue" && existing.expires_at !== null) {
        return { ok: false as const, code: "conflict" as const };
      }
      if (mode === "rotate" && existing.expires_at === null) {
        return { ok: false as const, code: "conflict" as const };
      }
      await this.tokenRepo.writeSecret(tokenId, tokenHash, expiresAt, tx);
      return { ok: true as const };
    });

    if (!result.ok) {
      if (result.code === "not_found") {
        return TOKEN_NOT_FOUND_ERROR;
      }
      return {
        ok: false,
        code: "conflict",
        message:
          mode === "issue"
            ? "Token already has an active secret; use rotate to replace it"
            : "Token has no active secret; use issue to create one",
      };
    }

    return {
      ok: true,
      issued: {
        token: s2Token,
        expires_at: expiresAt,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Revoke (clear token hash)
  // -------------------------------------------------------------------------

  async revoke(
    userId: string,
    tokenId: string,
  ): Promise<TokenResult<object, RevokeErrorCode>> {
    const found = await this.db.withUserWriteTx(this.userId, async (tx) => {
      const existing = await this.tokenRepo.getOwnedToken(tokenId, userId, tx);
      if (!existing) return false;
      await this.tokenRepo.revokeToken(tokenId, tx);
      return true;
    });
    if (!found) {
      return TOKEN_NOT_FOUND_ERROR;
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Replace access paths
  // -------------------------------------------------------------------------

  async replaceAccessPaths(
    userId: string,
    tokenId: string,
    paths: Array<{ path: string; access?: AccessLevel }>,
  ): Promise<
    TokenResult<{ access_paths: AccessPathRow[] }, ReplaceAccessPathsErrorCode>
  > {
    // Validate. Empty paths would leave the token authenticated but with no
    // scope (every request 403).
    const accessPathsArrayError = validateNonEmptyAccessPathsArray(paths);
    if (accessPathsArrayError) return accessPathsArrayError;
    const canonicalized = canonicalizeAccessPaths(paths, {
      checkAccess: true,
      duplicateMessage: (c) => `duplicate access_paths[].path: "${c}"`,
    });
    if (!canonicalized.ok) {
      return { ok: false, code: "invalid_input", message: canonicalized.error };
    }
    const normalized = canonicalized.paths;

    const found = await this.db.withUserWriteTx(this.userId, async (tx) => {
      const existing = await this.tokenRepo.getOwnedTokenDetail(
        tokenId,
        userId,
        tx,
      );
      if (!existing) return false;
      await this.tokenRepo.replaceAccessPaths(tokenId, normalized, tx);
      return true;
    });
    if (!found) {
      return TOKEN_NOT_FOUND_ERROR;
    }

    return {
      ok: true,
      access_paths: normalized,
    };
  }
}
