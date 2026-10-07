// TokenRepository: Postgres CRUD for grants + user_grants + grant_paths + access_tokens.
//
// Tokens (credentials) and permissions (grants) are separate:
// - grants:        unit of permission (generic: id / user_id / base_path / created_at)
// - user_grants:         details for manually created / delegated grants (name / can_delegate / parent_grant_id)
// - grant_paths:   path × read|write under a grant
// - access_tokens:       Bearer credential (1:1 with grant)
//
// OAuth grant details (oauth_grants) are managed separately by OAuthGrantRepository.
// This repository handles "user-issued tokens" and generic shared operations.

import type { AccessLevel, AccessPathRow } from "~/lib/auth/types";
import type {
  DbClient,
  WithinUserTx,
  WithinUserWriteTx,
} from "~/lib/db/client.server";
import { isPgError, PG_FK_VIOLATION } from "~/lib/db/pg-error";

/**
 * Raised by `deleteToken` when the token cannot be removed because at least
 * one delegation child still references it via the user_grants composite FK
 * (ON DELETE RESTRICT). Callers translate this into a 409 conflict.
 */
export class TokenHasChildrenError extends Error {
  constructor(grantId: string) {
    super(`grants.${grantId} has delegation children`);
    this.name = "TokenHasChildrenError";
  }
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** Flat row returned by the list-with-paths JOIN query (user_grants only). */
export interface TokenWithPathRow {
  id: string;
  name: string;
  base_path: string;
  token_can_delegate: boolean;
  origin_id: string | null;
  created_at: string;
  path: string | null;
  access: string | null;
  token_expires_at: string | null;
}

/** Row returned after authenticating by token hash. */
export interface AuthenticatedTokenRow {
  id: string;
  user_id: string;
  base_path: string;
  /** True for user_grants (manual/delegated). False for OAuth grants (oauth_grants). */
  can_delegate: boolean;
  /**
   * RFC 8707 audience binding. NULL = unbound (legacy api/webdav,
   * user_grants has no audience concept). For OAuth grants, returns oauth_grants.resource.
   */
  resource: string | null;
  /** Access paths attached to this grant. Loaded in the same RLS-scoped tx. */
  access_paths: AccessPathRow[];
}

/** Subset returned after PATCH update on user_grants. */
export interface UpdatedTokenRow {
  id: string;
  name: string;
  base_path: string;
  can_delegate: boolean;
}

/** Subset used for ownership checks that also need base_path. */
export interface OwnedTokenDetailRow {
  id: string;
  name: string;
  base_path: string;
}

/** Minimal ownership check row. (expires_at is from access_tokens) */
export interface OwnedTokenRow {
  id: string;
  name: string;
  expires_at: string | null;
}

/** Row for checking token origin (used by delete authorization). */
export interface TokenOriginRow {
  id: string;
  origin_id: string | null;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class TokenRepository {
  constructor(private db: DbClient) {}

  // -----------------------------------------------------------------------
  // Access grant count (manual + delegated + OAuth, single shared pool)
  // -----------------------------------------------------------------------

  async countByUser(userId: string, tx: WithinUserTx): Promise<number> {
    const row = await tx.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM grants
       WHERE user_id = $1`,
      [userId],
    );
    return Number(row?.cnt ?? 0);
  }

  // -----------------------------------------------------------------------
  // Create — user_grants (manual / delegated)
  // -----------------------------------------------------------------------

  async createToken(
    params: {
      id: string;
      userId: string;
      name: string;
      basePath: string;
      canDelegate: boolean;
      originId: string | null;
      createdAt: string;
    },
    tx: WithinUserWriteTx,
  ): Promise<void> {
    await tx.execute(
      `INSERT INTO grants (id, user_id, base_path, created_at)
       VALUES ($1, $2, $3, $4)`,
      [params.id, params.userId, params.basePath, params.createdAt],
    );
    await tx.execute(
      `INSERT INTO user_grants (grant_id, user_id, name, can_delegate, parent_grant_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        params.id,
        params.userId,
        params.name,
        params.canDelegate,
        params.originId,
      ],
    );
  }

  // -----------------------------------------------------------------------
  // Access paths (generic — applies to any grant type)
  // -----------------------------------------------------------------------

  async createAccessPaths(
    grantId: string,
    paths: ReadonlyArray<{
      path: string;
      access: AccessLevel;
    }>,
    tx: WithinUserWriteTx,
  ): Promise<void> {
    for (const p of paths) {
      await tx.execute(
        "INSERT INTO grant_paths (grant_id, path, access) VALUES ($1, $2, $3)",
        [grantId, p.path, p.access],
      );
    }
  }

  async deleteAccessPaths(
    grantId: string,
    tx: WithinUserWriteTx,
  ): Promise<void> {
    await tx.execute("DELETE FROM grant_paths WHERE grant_id = $1", [grantId]);
  }

  async replaceAccessPaths(
    grantId: string,
    paths: ReadonlyArray<{
      path: string;
      access: AccessLevel;
    }>,
    tx: WithinUserWriteTx,
  ): Promise<void> {
    await this.deleteAccessPaths(grantId, tx);
    await this.createAccessPaths(grantId, paths, tx);
  }

  async getAccessPaths(
    grantId: string,
    tx: WithinUserTx,
  ): Promise<AccessPathRow[]> {
    return tx.query<AccessPathRow>(
      "SELECT path, access FROM grant_paths WHERE grant_id = $1",
      [grantId],
    );
  }

  // -----------------------------------------------------------------------
  // List user_grants (with paths JOIN)
  // -----------------------------------------------------------------------

  /**
   * List all user_grants for a user (manual + delegated) with their access paths.
   * Returns flat rows; caller is responsible for aggregating by grant id.
   * OAuth grants are excluded — they belong to /connections.
   */
  async listWithPathsByUser(
    userId: string,
    tx: WithinUserTx,
  ): Promise<TokenWithPathRow[]> {
    return tx.query<TokenWithPathRow>(
      `SELECT g.id,
              ug.name,
              g.base_path,
              ug.can_delegate AS token_can_delegate,
              ug.parent_grant_id AS origin_id,
              g.created_at,
              p.path,
              p.access,
              at.expires_at AS token_expires_at
       FROM grants g
       JOIN user_grants ug ON ug.grant_id = g.id
       LEFT JOIN grant_paths p ON p.grant_id = g.id
       LEFT JOIN access_tokens at ON at.grant_id = g.id
       WHERE g.user_id = $1
       ORDER BY g.created_at ASC, g.id ASC, p.path ASC`,
      [userId],
    );
  }

  // -----------------------------------------------------------------------
  // Read (single user-token)
  // -----------------------------------------------------------------------

  async getOwnedToken(
    grantId: string,
    userId: string,
    tx: WithinUserTx,
  ): Promise<OwnedTokenRow | null> {
    return tx.queryOne<OwnedTokenRow>(
      `SELECT g.id, ug.name, at.expires_at
       FROM grants g
       JOIN user_grants ug ON ug.grant_id = g.id
       LEFT JOIN access_tokens at ON at.grant_id = g.id
       WHERE g.id = $1 AND g.user_id = $2`,
      [grantId, userId],
    );
  }

  async getOwnedTokenDetail(
    grantId: string,
    userId: string,
    tx: WithinUserTx,
  ): Promise<OwnedTokenDetailRow | null> {
    return tx.queryOne<OwnedTokenDetailRow>(
      `SELECT g.id, ug.name, g.base_path
       FROM grants g
       JOIN user_grants ug ON ug.grant_id = g.id
       WHERE g.id = $1 AND g.user_id = $2`,
      [grantId, userId],
    );
  }

  /** Get origin info for a token owned by a user (for delete authorization). */
  async getTokenOrigin(
    grantId: string,
    userId: string,
    tx: WithinUserTx,
  ): Promise<TokenOriginRow | null> {
    return tx.queryOne<TokenOriginRow>(
      `SELECT g.id, ug.parent_grant_id AS origin_id
       FROM grants g
       JOIN user_grants ug ON ug.grant_id = g.id
       WHERE g.id = $1 AND g.user_id = $2`,
      [grantId, userId],
    );
  }

  /**
   * Authenticate a token by its access_token hash.
   * Resolves resource from oauth_grants when applicable; user_grants have no resource.
   * Returns null if not found or expired.
   */
  /**
   * Token authentication entry point (per-request).
   *
   * 2-stage lookup so it works under RLS:
   *   1. Find access_tokens row by hash (RLS-excluded). Yields user_id +
   *      grant_id without crossing any RLS-protected table.
   *   2. Open `withUserTx(user_id, ...)` and fetch full grant info via the
   *      RLS-protected joins.
   */
  async findByHash(tokenHash: string): Promise<AuthenticatedTokenRow | null> {
    const meta = await this.db.queryOne<{ user_id: string; grant_id: string }>(
      `SELECT user_id, grant_id FROM access_tokens
       WHERE token_hash = $1 AND expires_at > now()`,
      [tokenHash],
    );
    if (!meta) return null;

    return this.db.withUserTx(meta.user_id, async (tx) => {
      // Re-verify the access_tokens row inside the tx so a rotation that
      // committed between stage 1 and stage 2 invalidates this auth attempt.
      const stillValid = await tx.queryOne<{ token_hash: string }>(
        `SELECT token_hash FROM access_tokens
         WHERE grant_id = $1 AND token_hash = $2 AND expires_at > now()`,
        [meta.grant_id, tokenHash],
      );
      if (!stillValid) return null;

      const grant = await tx.queryOne<{
        id: string;
        user_id: string;
        base_path: string;
        can_delegate: boolean;
        resource: string | null;
      }>(
        `SELECT g.id,
                g.user_id,
                g.base_path,
                COALESCE(ug.can_delegate, false) AS can_delegate,
                og.resource
         FROM grants g
         LEFT JOIN user_grants  ug ON ug.grant_id = g.id
         LEFT JOIN oauth_grants og ON og.grant_id = g.id
         WHERE g.id = $1`,
        [meta.grant_id],
      );
      if (!grant) return null;

      const access_paths = await tx.query<AccessPathRow>(
        "SELECT path, access FROM grant_paths WHERE grant_id = $1",
        [meta.grant_id],
      );
      return { ...grant, access_paths };
    });
  }

  // -----------------------------------------------------------------------
  // Update — user_grants
  // -----------------------------------------------------------------------

  async updateToken(
    grantId: string,
    updates: {
      name?: string;
      basePath?: string;
      canDelegate?: boolean;
    },
    tx: WithinUserWriteTx,
  ): Promise<UpdatedTokenRow | null> {
    if (updates.basePath !== undefined) {
      await tx.execute("UPDATE grants SET base_path = $1 WHERE id = $2", [
        updates.basePath,
        grantId,
      ]);
    }

    const ugSets: string[] = [];
    const ugBinds: unknown[] = [];
    let idx = 1;
    if (updates.name !== undefined) {
      ugSets.push(`name = $${idx++}`);
      ugBinds.push(updates.name);
    }
    if (updates.canDelegate !== undefined) {
      ugSets.push(`can_delegate = $${idx++}`);
      ugBinds.push(updates.canDelegate);
    }
    if (ugSets.length > 0) {
      ugBinds.push(grantId);
      await tx.execute(
        `UPDATE user_grants SET ${ugSets.join(", ")} WHERE grant_id = $${idx}`,
        ugBinds,
      );
    }

    if (
      updates.name === undefined &&
      updates.basePath === undefined &&
      updates.canDelegate === undefined
    ) {
      return null;
    }

    return tx.queryOne<UpdatedTokenRow>(
      `SELECT g.id, ug.name, g.base_path, ug.can_delegate
       FROM grants g
       JOIN user_grants ug ON ug.grant_id = g.id
       WHERE g.id = $1`,
      [grantId],
    );
  }

  /**
   * Update the base_path of a grant (used for OAuth re-consent).
   * Works for any grant origin since base_path lives on grants.
   */
  async updateBasePath(
    grantId: string,
    basePath: string,
    tx: WithinUserWriteTx,
  ): Promise<void> {
    await tx.execute("UPDATE grants SET base_path = $1 WHERE id = $2", [
      basePath,
      grantId,
    ]);
  }

  /**
   * Write a Bearer credential for a grant (UPSERT into access_tokens).
   * Used by both issue (first-time) and rotate (replace) flows.
   * resource lives on oauth_grants now, not on access_tokens.
   */
  async writeSecret(
    grantId: string,
    tokenHash: string,
    expiresAt: string,
    tx: WithinUserWriteTx,
  ): Promise<void> {
    // user_id is sourced from grants via SELECT — under RLS this only
    // returns the row owned by current app.user_id, so a wrong-user write
    // is silently rejected (0 rows inserted). Composite FK on (grant_id,
    // user_id) → grants(id, user_id) guarantees consistency.
    await tx.execute(
      `INSERT INTO access_tokens (grant_id, user_id, token_hash, expires_at)
       SELECT id, user_id, $2, $3 FROM grants WHERE id = $1
       ON CONFLICT (grant_id) DO UPDATE
         SET token_hash = EXCLUDED.token_hash,
             expires_at = EXCLUDED.expires_at`,
      [grantId, tokenHash, expiresAt],
    );
  }

  /** Revoke the Bearer credential for a grant (delete the access_tokens row). */
  async revokeToken(grantId: string, tx: WithinUserWriteTx): Promise<void> {
    await tx.execute("DELETE FROM access_tokens WHERE grant_id = $1", [
      grantId,
    ]);
  }

  // -----------------------------------------------------------------------
  // Delete (CASCADE removes user_grants/oauth_grants/paths/access/refresh)
  // -----------------------------------------------------------------------

  async deleteToken(grantId: string, tx: WithinUserWriteTx): Promise<void> {
    try {
      await tx.execute("DELETE FROM grants WHERE id = $1", [grantId]);
    } catch (e) {
      // user_grants.parent_grant_id ON DELETE RESTRICT: blocks the
      // delete when delegation children still exist. Re-raise as a typed
      // error the service layer can map to a 409 conflict.
      if (isPgError(e) && e.code === PG_FK_VIOLATION) {
        throw new TokenHasChildrenError(grantId);
      }
      throw e;
    }
  }
}
