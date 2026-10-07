// UserRepository: Postgres CRUD for the Better Auth `user` table and the
// s2-owned `user_limits` / `user_storage` side tables (split
// pattern). Consolidates all raw SQL that touches these tables into one place
// so callers stay agnostic about the auth-vs-limits split.

import type {
  DbClient,
  WithinUserTx,
  WithinUserWriteTx,
} from "~/lib/db/client.server";
import { DEFAULT_USER_LIMITS } from "./quota-service.server";

export interface User {
  id: string;
  email: string;
  storage_limit_bytes: number;
  grant_limit: number;
  revision_limit: number;
  bytes_used: number;
  created_at: string;
  last_sign_in_at: string | null;
  // True after the user enables TOTP and successfully
  // verifies it once. Drives the /settings 2FA panel state and the sign-in
  // flow's twoFactorRedirect (Better Auth checks this column server-side; we
  // surface it in the User shape so the UI can render the panel without a
  // second round-trip).
  two_factor_enabled: boolean;
}

export interface QuotaInfo {
  bytes_used: number;
  storage_limit_bytes: number;
  grant_limit: number;
  revision_limit: number;
}

// SELECT used everywhere the User shape is materialized from the joined
// auth + side tables. user_limits / user_storage rows are seeded atomically
// in the Better Auth user.create.after hook — we still LEFT JOIN so a missing
// row degrades to defaults instead of dropping the user from results.
const SELECT_USER_JOINED = `
  SELECT u.id,
         u.email,
         COALESCE(l.storage_limit_bytes, ${DEFAULT_USER_LIMITS.storage_limit_bytes}) AS storage_limit_bytes,
         COALESCE(l.grant_limit, ${DEFAULT_USER_LIMITS.grant_limit}) AS grant_limit,
         COALESCE(l.revision_limit, ${DEFAULT_USER_LIMITS.revision_limit}) AS revision_limit,
         COALESCE(s.bytes_used, 0) AS bytes_used,
         u."createdAt"::text AS created_at,
         u.last_sign_in_at,
         COALESCE(u."twoFactorEnabled", false) AS two_factor_enabled
    FROM "user" u
    LEFT JOIN user_limits l ON l.user_id = u.id
    LEFT JOIN user_storage s ON s.user_id = u.id
`;

export class UserRepository {
  constructor(private db: DbClient) {}

  // ── Read ──────────────────────────────────────────────────────────

  async getById(id: string, tx: WithinUserTx): Promise<User | null> {
    return tx.queryOne<User>(`${SELECT_USER_JOINED} WHERE u.id = $1`, [id]);
  }

  async getQuotaInfo(id: string, tx: WithinUserTx): Promise<QuotaInfo | null> {
    return tx.queryOne<QuotaInfo>(
      `SELECT COALESCE(s.bytes_used, 0) AS bytes_used,
              COALESCE(l.storage_limit_bytes, ${DEFAULT_USER_LIMITS.storage_limit_bytes}) AS storage_limit_bytes,
              COALESCE(l.grant_limit, ${DEFAULT_USER_LIMITS.grant_limit}) AS grant_limit,
              COALESCE(l.revision_limit, ${DEFAULT_USER_LIMITS.revision_limit}) AS revision_limit
         FROM "user" u
         LEFT JOIN user_limits l ON l.user_id = u.id
         LEFT JOIN user_storage s ON s.user_id = u.id
        WHERE u.id = $1`,
      [id],
    );
  }

  /**
   * List every user_id. Cron uses this to fan out per user under
   * `withUserTx`.
   */
  async listAllUserIds(): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      'SELECT id FROM "user" ORDER BY "createdAt"',
    );
    return rows.map((r) => r.id);
  }

  // ── Write ─────────────────────────────────────────────────────────

  /**
   * Insert a row into "user" + atomically seed user_limits / user_storage.
   * Used by the integration-test seeding helpers and any path that needs to
   * mint a user outside the Better Auth sign-up flow (e.g. cron tests).
   *
   * Better Auth's `user` table requires `name` / `emailVerified` NOT NULL —
   * we default `name` to the local-part of the email and `emailVerified` to
   * false. Callers that want different values should INSERT into "user"
   * directly.
   */
  async create(
    id: string,
    email: string,
    createdAt: string,
    tx: DbClient,
  ): Promise<void> {
    // Mirror Better Auth's default email handling (lower-case + trim) so test
    // helpers and the real sign-up flow store comparable values. No further
    // canonicalization (Gmail dots / +tags) — we rely on Better Auth defaults.
    const normalized = email.trim().toLowerCase();
    const name = normalized.split("@")[0] ?? normalized;
    await tx.execute(
      `INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, false, $4, $4)`,
      [id, normalized, name, createdAt],
    );
    await tx.execute(
      "INSERT INTO user_limits (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
      [id],
    );
    await tx.execute(
      "INSERT INTO user_storage (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
      [id],
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.execute('DELETE FROM "user" WHERE id = $1', [id]);
  }

  // ── Storage ───────────────────────────────────────────────────────

  /**
   * Atomically adjust bytes_used without allowing it to become negative.
   */
  async addBytesUsed(
    delta: number,
    userId: string,
    tx: WithinUserWriteTx,
  ): Promise<void> {
    await tx.execute(
      `UPDATE user_storage
          SET bytes_used = GREATEST(0, bytes_used + $1::bigint)
        WHERE user_id = $2`,
      [delta, userId],
    );
  }

  /**
   * Set bytes_used to an absolute value.
   */
  async setBytesUsed(
    bytesUsed: number,
    userId: string,
    tx: WithinUserWriteTx,
  ): Promise<void> {
    await tx.execute(
      `UPDATE user_storage SET bytes_used = $1::bigint WHERE user_id = $2`,
      [bytesUsed, userId],
    );
  }
}
