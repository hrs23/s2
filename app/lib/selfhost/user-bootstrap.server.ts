import { hashPassword } from "better-auth/crypto";
import pg from "pg";
import { newId } from "~/lib/utils/ulid.server";

export interface CreateSelfHostUserInput {
  readonly databaseUrl: string;
  readonly email: string;
  readonly password: string;
  readonly name?: string;
}

export interface CreateSelfHostUserResult {
  readonly id: string;
  readonly email: string;
  readonly firstUser: boolean;
}

export interface SetSelfHostUserPasswordInput {
  readonly databaseUrl: string;
  readonly email: string;
  readonly password: string;
}

export interface SetSelfHostUserPasswordResult {
  readonly id: string;
  readonly email: string;
}

export async function createSelfHostUser(
  input: CreateSelfHostUserInput,
): Promise<CreateSelfHostUserResult> {
  const email = normalizeEmail(input.email);
  validatePassword(input.password);
  const pool = new pg.Pool({ connectionString: input.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query<{ id: string }>(
      'SELECT id FROM "user" WHERE email = $1',
      [email],
    );
    if (existing.rows.length > 0) {
      throw new Error(`User already exists: ${email}`);
    }

    const countResult = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM "user"',
    );
    const firstUser = countResult.rows[0]?.count === "0";
    const userId = newId("user_", 32);
    const accountId = newId("acc_", 32);
    const defaultGrantId = newId("tok_");
    const now = new Date();
    const passwordHash = await hashPassword(input.password);
    const name = input.name?.trim() || email.split("@")[0] || email;

    await client.query(
      `INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, true, $4, $4)`,
      [userId, email, name, now],
    );
    await client.query(
      `INSERT INTO "account" (id, "userId", "providerId", "accountId", password, "createdAt", "updatedAt")
       VALUES ($1, $2, 'credential', $2, $3, $4, $4)`,
      [accountId, userId, passwordHash, now],
    );
    await client.query(
      "INSERT INTO user_limits (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
      [userId],
    );
    await client.query(
      "INSERT INTO user_storage (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
      [userId],
    );
    await client.query(
      `INSERT INTO grants (id, user_id, base_path, created_at)
       VALUES ($1, $2, '/', $3)`,
      [defaultGrantId, userId, now.toISOString()],
    );
    await client.query(
      `INSERT INTO user_grants (grant_id, user_id, name, can_delegate, parent_grant_id)
       VALUES ($1, $2, 'Default', true, NULL)`,
      [defaultGrantId, userId],
    );
    await client.query(
      `INSERT INTO grant_paths (grant_id, path, access)
       VALUES ($1, '', 'write')`,
      [defaultGrantId],
    );

    await client.query("COMMIT");
    return { id: userId, email, firstUser };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export async function setSelfHostUserPassword(
  input: SetSelfHostUserPasswordInput,
): Promise<SetSelfHostUserPasswordResult> {
  const email = normalizeEmail(input.email);
  validatePassword(input.password);
  const pool = new pg.Pool({ connectionString: input.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const user = await client.query<{ id: string }>(
      'SELECT id FROM "user" WHERE email = $1',
      [email],
    );
    const userId = user.rows[0]?.id;
    if (!userId) {
      throw new Error(`User not found: ${email}`);
    }

    const passwordHash = await hashPassword(input.password);
    const result = await client.query(
      `UPDATE "account"
       SET password = $1, "updatedAt" = $2
       WHERE "userId" = $3 AND "providerId" = 'credential'`,
      [passwordHash, new Date(), userId],
    );
    if (result.rowCount !== 1) {
      throw new Error(`Password account not found: ${email}`);
    }
    await client.query('DELETE FROM "session" WHERE "userId" = $1', [userId]);

    await client.query("COMMIT");
    return { id: userId, email };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error(`Invalid email: ${email}`);
  }
  return normalized;
}

function validatePassword(password: string): void {
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  if (password.length > 128) {
    throw new Error("Password must be at most 128 characters");
  }
}
