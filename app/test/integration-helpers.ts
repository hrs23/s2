/**
 * Shared helpers for integration tests.
 * Sets up PostgreSQL (PGlite) + filesystem storage, seeds users/tokens.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { createAppContext } from "~/lib/app-context.server";
import { hashToken } from "~/lib/auth/token.server";
import type { DbClient, WithinUserWriteTx } from "~/lib/db/client.server";
import { createMemorySecondaryStorage } from "~/lib/selfhost/memory-secondary-storage.server";
import { FileSystemStorageAdapter } from "~/lib/storage/filesystem.server";
import { createPgPoolFromPGlite } from "./pglite-pg-pool";
import { createTestDb } from "./test-db";

// ── WithinUserTx brand casts (test-only) ───────────────────
//
// The integration-test PGlite database runs as a PG superuser (BYPASSRLS),
// so RLS policies are silently bypassed — there's no behavioural difference
// between calling a repository method with `db` vs with a brand-cast
// `db as WithinUserTx`. The unique-symbol brand exists only at the TypeScript
// level and is enforced at production callsites via `db.withUserTx` /
// `db.withUserWriteTx`.
//
// `scripts/check-no-rls-bypass.sh` allowlists `app/test/` for the cast.
//
// Production code MUST NOT use these helpers — opening a real `withUserTx`
// is the only correct path there.

/**
 * Brand a test DbClient as a `WithinUserWriteTx`. Because `WithinUserWriteTx`
 * is a subtype of `WithinUserTx`, the same value satisfies both read- and
 * write-tx positions in repository signatures — one helper covers both.
 *
 * Safe for tests only. The test PGlite client behaves identically with or
 * without the brand because RLS is bypassed by the test role.
 */
export function asTestTx(db: DbClient): WithinUserWriteTx {
  return db as WithinUserWriteTx;
}

/**
 * Brand-only placeholder for pure unit tests that mock the repository layer
 * and never actually consult `tx`. Saves callers from spelling
 * `asTestTx({} as never)` at the top of every such file.
 *
 * Use only when the test does not exercise any code path that reads from
 * `tx`. Integration tests that hit the real PGlite client must use
 * `asTestTx(db)` instead.
 */
export function asMockTx(): WithinUserWriteTx {
  return {} as WithinUserWriteTx;
}

// ── Constants ──────────────────────────────────────────────

const TEST_AUTH_SECRET = "test-auth-secret-for-integration-tests";

// ── Test Env ──────────────────────────────────────────────

export interface TestEnv {
  db: DbClient;
  storage: FileSystemStorageAdapter;
  storageRoot: string;
  env: Env;
}

export function testLoadContext(testEnv: TestEnv) {
  return {
    appContext: createAppContext(testEnv.env),
    runtime: { env: testEnv.env },
  };
}

export async function createTestEnv(): Promise<TestEnv> {
  const db = await createTestDb();
  const pglite = (db as DbClient & { __pglite?: PGlite }).__pglite;
  const testAuthPool = pglite ? createPgPoolFromPGlite(pglite) : undefined;
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "s2-test-storage-"));
  const storage = new FileSystemStorageAdapter(storageRoot);
  const authStorage = createMemorySecondaryStorage();

  const env = {
    AUTH_STORAGE: authStorage,
    AUTH_SECRET: TEST_AUTH_SECRET,
    APP_URL: "http://localhost:8888",
    ALLOWED_RESOURCES:
      "http://localhost:8787/mcp,http://localhost:8888/mcp,http://localhost/mcp",
    DATABASE_URL: "postgres://stub:stub@stub:5432/stub",
    __testDbClient: db,
    __authPoolOverride: testAuthPool,
    __storageAdapter: storage,
  } as unknown as Env;

  return { db, storage, storageRoot, env };
}

/** Reset all tables between tests for isolation.
 *
 * TRUNCATE file_revisions is forbidden because it bypasses the
 * storage_tombstones trigger and would orphan blob chunks. We use DELETE
 * everywhere that touches file_revisions (directly or via CASCADE) so the
 * trigger fires and storage_tombstones stays consistent — then we wipe
 * the tombstones table at the end. Other tables can still be TRUNCATEd
 * for speed because they don't gate the storage invariant. */
export async function cleanTestEnv(testEnv: TestEnv): Promise<void> {
  await testEnv.db.execute("DELETE FROM file_nodes");
  await testEnv.db.execute("DELETE FROM storage_tombstones");

  await testEnv.db.execute(`
    TRUNCATE
      upload_session_chunks,
      upload_sessions,
      oauth_authorization_codes,
      refresh_tokens,
      access_tokens,
      grant_paths,
      grants,
      oauth_clients,
      "session",
      "account",
      "verification",
      "twoFactor",
      user_limits,
      user_storage,
      "user"
    CASCADE
  `);

  const listed = await readdir(testEnv.storageRoot);
  for (const entry of listed) {
    await rm(path.join(testEnv.storageRoot, entry), {
      recursive: true,
      force: true,
    });
  }
}

export async function disposeTestEnv(testEnv: TestEnv): Promise<void> {
  await rm(testEnv.storageRoot, { recursive: true, force: true });
}

// ── User & Token Helpers ───────────────────────────────────

interface UserLimitOverrides {
  storage_limit_bytes?: number;
  grant_limit?: number;
  revision_limit?: number;
}

/** Common finite limits for quota enforcement tests. */
export const FINITE_TEST_LIMITS = {
  storage_limit_bytes: 250 * 1024 * 1024,
  grant_limit: 5,
  revision_limit: 30,
} as const;

export interface TestUser {
  id: string;
  email: string;
  limits: UserLimitOverrides;
}

/**
 * Lower-level seed for integration tests. Rows must
 * land in `"user"` + user_limits + user_storage. This helper wraps the
 * three-statement seed so call-sites stay short.
 */
export async function seedTestUser(
  db: DbClient,
  opts: {
    id: string;
    email: string;
    limits?: UserLimitOverrides;
    bytesUsed?: number;
    createdAt?: string;
  },
): Promise<void> {
  const createdAt = opts.createdAt ?? new Date().toISOString();
  const limits = opts.limits ?? {};
  await db.execute(
    `INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, true, $4, $4)
     ON CONFLICT (id) DO NOTHING`,
    [opts.id, opts.email, opts.email.split("@")[0] ?? opts.email, createdAt],
  );
  await db.execute(
    `INSERT INTO user_limits (user_id, storage_limit_bytes, grant_limit, revision_limit)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       storage_limit_bytes = EXCLUDED.storage_limit_bytes,
       grant_limit = EXCLUDED.grant_limit,
       revision_limit = EXCLUDED.revision_limit`,
    [
      opts.id,
      limits.storage_limit_bytes ?? 0,
      limits.grant_limit ?? 0,
      limits.revision_limit ?? 0,
    ],
  );
  await db.execute(
    `INSERT INTO user_storage (user_id, bytes_used) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET bytes_used = EXCLUDED.bytes_used`,
    [opts.id, opts.bytesUsed ?? 0],
  );
}

export async function createTestUser(
  db: DbClient,
  opts: { id?: string; email?: string; limits?: UserLimitOverrides } = {},
): Promise<TestUser> {
  const id = opts.id ?? `user_${crypto.randomUUID().slice(0, 8)}`;
  const email = opts.email ?? `${id}@test.local`;
  const limits = opts.limits ?? {};
  await seedTestUser(db, { id, email, limits });
  return { id, email, limits };
}

export interface TestToken {
  id: string;
  rawToken: string;
  hash: string;
}

export async function issueTestToken(
  db: DbClient,
  opts: {
    userId: string;
    name?: string;
    canDelegate?: boolean;
    basePath?: string;
    paths?: Array<{ path: string; access?: "read" | "write" }>;
  },
): Promise<TestToken> {
  const tokenId = `tok_${crypto.randomUUID().slice(0, 8)}`;
  const rawToken = `s2_test${crypto.randomUUID().replace(/-/g, "").slice(0, 27)}`;
  const hash = await hashToken(rawToken);
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 86400000).toISOString();

  await db.execute(
    "INSERT INTO grants (id, user_id, base_path, created_at) VALUES ($1, $2, $3, $4)",
    [tokenId, opts.userId, opts.basePath ?? "/", now],
  );
  await db.execute(
    "INSERT INTO user_grants (grant_id, user_id, name, can_delegate, parent_grant_id) VALUES ($1, $2, $3, $4, NULL)",
    [
      tokenId,
      opts.userId,
      opts.name ?? "test-token",
      opts.canDelegate ?? false,
    ],
  );

  await db.execute(
    `INSERT INTO access_tokens (grant_id, user_id, token_hash, expires_at)
     SELECT id, user_id, $2, $3 FROM grants WHERE id = $1`,
    [tokenId, hash, expires],
  );

  const paths = opts.paths ?? [{ path: "", access: "write" }];
  for (const p of paths) {
    await db.execute(
      "INSERT INTO grant_paths (grant_id, path, access) VALUES ($1, $2, $3)",
      [tokenId, p.path, p.access ?? "read"],
    );
  }

  return { id: tokenId, rawToken, hash };
}

/**
 * Seed a token row WITHOUT an active secret (token_hash / expires_at are
 * NULL). Lets integration tests exercise the "issue for the first time"
 * path, since `issueTestToken` above already sets a secret.
 */
export async function createUnissuedTestToken(
  db: DbClient,
  opts: {
    userId: string;
    name?: string;
    canDelegate?: boolean;
    basePath?: string;
  },
): Promise<{ id: string }> {
  const tokenId = `tok_${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  await db.execute(
    "INSERT INTO grants (id, user_id, base_path, created_at) VALUES ($1, $2, $3, $4)",
    [tokenId, opts.userId, opts.basePath ?? "/", now],
  );
  await db.execute(
    "INSERT INTO user_grants (grant_id, user_id, name, can_delegate, parent_grant_id) VALUES ($1, $2, $3, $4, NULL)",
    [
      tokenId,
      opts.userId,
      opts.name ?? "test-token-unissued",
      opts.canDelegate ?? false,
    ],
  );
  await db.execute(
    "INSERT INTO grant_paths (grant_id, path, access) VALUES ($1, '', 'write')",
    [tokenId],
  );
  return { id: tokenId };
}

// ── Assertion Helpers ──────────────────────────────────────

export function basicAuthHeader(token: string): string {
  return `Basic ${btoa(`user:${token}`)}`;
}

export function bearerHeader(token: string): string {
  return `Bearer ${token}`;
}

/**
 * Build a `Cookie` header value carrying a real Better Auth session for the
 * given user. Use this on integration tests targeting `/internal/*` routes
 * (cookie-only) or `/api/v1/*` routes invoked from the WebUI.
 */
export async function sessionCookieHeader(
  userId: string,
  env: Env,
): Promise<string> {
  const { createAuth } = await import("~/lib/auth.server");
  const { makeSignature } = await import("better-auth/crypto");
  const auth = createAuth(env);
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(userId, false);
  const signed = `${session.token}.${await makeSignature(session.token, ctx.secret)}`;
  return `${ctx.authCookies.sessionToken.name}=${signed}`;
}
