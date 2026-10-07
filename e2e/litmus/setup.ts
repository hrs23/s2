/**
 * Create a test user and token for litmus WebDAV conformance testing.
 * Usage: pnpm exec tsx e2e/litmus/setup.ts
 *
 * Connects to local PostgreSQL and inserts a Better Auth `"user"` row +
 * the s2 side tables + a default access token. Prints the raw token to
 * stdout for use with litmus.
 */
import pg from "pg";
import { generateS2Token, hashToken } from "../../app/lib/auth/token.server";

const DB_URL =
  process.env.DB_URL ?? "postgres://postgres:postgres@localhost:5432/s2";
const USER_ID = "litmus_user";
const TOKEN_NAME = "litmus-test";

async function main() {
  const client = new pg.Client(DB_URL);
  await client.connect();

  try {
    // write to "user" + side tables, not the dropped legacy
    // `users` table. emailVerified=true skips the link click.
    const now = new Date().toISOString();
    await client.query(
      `INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, 'litmus@test.local', 'Litmus', true, $2, $2)
       ON CONFLICT (id) DO UPDATE SET "emailVerified" = true`,
      [USER_ID, now],
    );
    await client.query(
      `INSERT INTO user_limits (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [USER_ID],
    );
    await client.query(
      `INSERT INTO user_storage (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [USER_ID],
    );

    // Clean up old litmus grants
    await client.query(
      `DELETE FROM grants
       WHERE user_id = $1
         AND id IN (SELECT grant_id FROM user_grants WHERE name = $2)`,
      [USER_ID, TOKEN_NAME],
    );

    // Generate token
    const rawToken = generateS2Token();
    const hash = await hashToken(rawToken);
    const tokenId = `tok_litmus_${Date.now()}`;
    const expires = new Date(
      Date.now() + 24 * 60 * 60 * 1000,
    ).toISOString();

    await client.query(
      `INSERT INTO grants (id, user_id, base_path, created_at)
       VALUES ($1, $2, '/', now())`,
      [tokenId, USER_ID],
    );

    await client.query(
      `INSERT INTO user_grants (grant_id, user_id, name, can_delegate)
       VALUES ($1, $2, $3, false)`,
      [tokenId, USER_ID, TOKEN_NAME],
    );

    // user_id is taken from grants (denormalized for the composite FK).
    await client.query(
      `INSERT INTO access_tokens (grant_id, user_id, token_hash, expires_at)
       SELECT id, user_id, $2, $3 FROM grants WHERE id = $1`,
      [tokenId, hash, expires],
    );

    // Grant full access. Access paths are
    // base_path-relative and "" is the canonical root (no leading slash).
    await client.query(
      `INSERT INTO grant_paths (grant_id, path, access)
       VALUES ($1, '', 'write')`,
      [tokenId],
    );

    console.log(rawToken);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
