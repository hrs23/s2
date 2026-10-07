// RefreshTokenRepository: CRUD for the refresh_tokens table.
//
// Separation of concerns:
// - used_at: consumed by a normal rotation / drives reuse detection (RFC 9700 §4.14)
// - revoked_at + revocation_reason: explicit revoke / re-consent
//
// The active leaf is only (used_at IS NULL AND revoked_at IS NULL). A partial
// UNIQUE index enforces "one per grant" in the schema. Since grant = refresh
// family, there is no self-referencing parent_id lineage.

import type { DbClient, WithinUserWriteTx } from "~/lib/db/client.server";

export type RevocationReason = "reconsent";

export interface RefreshTokenRow {
  id: string;
  grant_id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  revocation_reason: RevocationReason | null;
  created_at: string;
}

export interface InsertRefreshTokenParams {
  id: string;
  grantId: string;
  tokenHash: string;
  expiresAt: string;
}

export class RefreshTokenRepository {
  constructor(private db: DbClient) {}

  /** Insert a new refresh token row (initial issue or rotation child). */
  async insert(
    params: InsertRefreshTokenParams,
    tx: WithinUserWriteTx,
  ): Promise<void> {
    // user_id sourced from grants under RLS (see access_tokens insert).
    await tx.execute(
      `INSERT INTO refresh_tokens (id, grant_id, user_id, token_hash, expires_at)
       SELECT $1, id, user_id, $3, $4 FROM grants WHERE id = $2`,
      [params.id, params.grantId, params.tokenHash, params.expiresAt],
    );
  }

  /**
   * Find a refresh token by hash regardless of state (for reuse detection /
   * revoke checks). Excluded from RLS; user_id is denormalized so the caller
   * can open `withUserTx` afterwards.
   */
  async findByHash(tokenHash: string): Promise<RefreshTokenRow | null> {
    return this.db.queryOne<RefreshTokenRow>(
      `SELECT id, grant_id, user_id, token_hash, expires_at, used_at,
              revoked_at, revocation_reason, created_at
       FROM refresh_tokens
       WHERE token_hash = $1`,
      [tokenHash],
    );
  }

  /**
   * Atomically mark a refresh token as used (rotation consume).
   * Returns the row if successfully consumed (active and not expired).
   * Returns null if the token was already used / revoked / expired.
   */
  async consume(
    id: string,
    tx: WithinUserWriteTx,
  ): Promise<RefreshTokenRow | null> {
    return tx.queryOne<RefreshTokenRow>(
      `UPDATE refresh_tokens
       SET used_at = now()
       WHERE id = $1
         AND used_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > now()
       RETURNING id, grant_id, user_id, token_hash, expires_at, used_at,
                 revoked_at, revocation_reason, created_at`,
      [id],
    );
  }

  /**
   * Revoke all active refresh tokens for a grant (re-consent / explicit revoke).
   * Sets revoked_at + revocation_reason, leaving used_at untouched so reuse
   * detection isn't triggered for the legitimate "I just re-consented" case.
   */
  async revokeAllForGrant(
    grantId: string,
    reason: RevocationReason,
    tx: WithinUserWriteTx,
  ): Promise<void> {
    await tx.execute(
      `UPDATE refresh_tokens
       SET revoked_at = now(), revocation_reason = $2
       WHERE grant_id = $1 AND revoked_at IS NULL AND used_at IS NULL`,
      [grantId, reason],
    );
  }
}
