// Postgres DB client abstraction using pg (node-postgres).
//
// `transaction(fn)`     — generic transaction. Use for system / cron / webhook
//                         flows where there is no end-user identity.
// `withUserTx(uid, fn)` — user-scoped transaction. Wraps the body in a
//                         transaction-local `app.user_id` GUC so RLS policies
//                         can match `using
//                         (user_id = current_setting('app.user_id')::uuid)`.
//                         Required for any code path that touches user-owned
//                         tables under the `app` DB role (NOBYPASSRLS).

import type { PoolClient } from "pg";
import pg from "pg";
import { logError, logWarn } from "~/lib/observability/logger.server";

// Parse BIGINT (OID 20) as JavaScript number instead of string.
// Safe for values up to Number.MAX_SAFE_INTEGER (9007199254740991 ≈ 9PB).
pg.types.setTypeParser(20, (val: string) => Number.parseInt(val, 10));

/**
 * SQL for the per-user writer serialization lock. Exported so tests can
 * assert on the literal string instead of a substring match.
 */
export const ADVISORY_USER_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))";

// Phantom-typed brand for RLS scope. `unique symbol` makes the property
// non-forgeable outside this module: anyone declaring their own object
// with a `[__withinUserTx]` key would need to reference the same symbol,
// which is not exported. This is the last fence behind RLS:
// any repository that touches an RLS-protected table must take a
// `WithinUserTx` (or `WithinUserWriteTx`), and the only way to produce
// one is to enter `withUserTx` / `withUserWriteTx` (which set `app.user_id`)
// or call `wrapUserTxPoolClient` (which verifies the GUC is already set).
declare const __withinUserTx: unique symbol;
declare const __withinUserWriteTx: unique symbol;

/**
 * A `DbClient` that is guaranteed to be running inside a `withUserTx` —
 * i.e. `app.user_id` is set, so RLS policies will scope to
 * the current user. Required by every repository that reads or writes an
 * RLS-protected table (see `migrations/20260101000000_init.sql`).
 *
 * The brand is a phantom property: there is no runtime check on the type
 * itself, only at the boundaries where a `WithinUserTx` is produced
 * (`withUserTx`, `withUserWriteTx`, `wrapUserTxPoolClient`). Once you
 * have one, the type system propagates it through nested calls.
 */
export interface WithinUserTx extends DbClient {
  readonly [__withinUserTx]: true;
}

/**
 * A `WithinUserTx` that additionally holds the per-user advisory write
 * lock from `pg_advisory_xact_lock`. Required by repository methods that
 * must serialize against other writers for the same user (see the
 * concurrent-write note below). Subtype of `WithinUserTx`: any RLS read path that accepts
 * `WithinUserTx` also accepts a `WithinUserWriteTx`.
 */
export interface WithinUserWriteTx extends WithinUserTx {
  readonly [__withinUserWriteTx]: true;
}

export interface DbClient {
  // biome-ignore lint/suspicious/noExplicitAny: generic DB row type
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  // biome-ignore lint/suspicious/noExplicitAny: generic DB row type
  queryOne<T = any>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
  /**
   * User-scoped transaction. Sets `app.user_id` as a transaction-local GUC
   * (`set_config(..., true)`) before invoking `fn`, so RLS policies on
   * user-owned tables can match the current user without an explicit
   * `WHERE user_id = $1` clause.
   *
   * `userId` must be a UUID-shaped string; it is passed as a query
   * parameter, not interpolated.
   *
   * `opts.isolation` issues `SET TRANSACTION ISOLATION LEVEL ...` before
   * `set_config` (PG requires it to be the first command in the tx).
   */
  withUserTx<T>(
    userId: string,
    fn: (tx: WithinUserTx) => Promise<T>,
    opts?: { isolation?: "repeatable read" | "serializable" },
  ): Promise<T>;
  /**
   * Writer-scoped transaction. Same as `withUserTx` plus a per-user
   * `pg_advisory_xact_lock` so concurrent writers for the same user serialize
   * at the tx boundary. Reads stay on `withUserTx` and are unaffected.
   * This is needed to prevent write-skew between
   * soft-delete and PUT/MKDIR/MOVE/RESTORE under READ COMMITTED.
   */
  withUserWriteTx<T>(
    userId: string,
    fn: (tx: WithinUserWriteTx) => Promise<T>,
    opts?: { isolation?: "repeatable read" | "serializable" },
  ): Promise<T>;
  ping(): Promise<void>;
}

/**
 * Internal-only: brand an existing `DbClient` as `WithinUserTx`. Only call
 * this from a context where the caller has just set `app.user_id`. The
 * unique-symbol property is not actually written at runtime — it's a
 * type-level assertion.
 */
function brandAsUserTx(client: DbClient): WithinUserTx {
  return client as WithinUserTx;
}

function brandAsUserWriteTx(client: DbClient): WithinUserWriteTx {
  return client as WithinUserWriteTx;
}

/**
 * Adapt a raw pg `PoolClient` to the `DbClient` shape. Exported so callers
 * that are already managing their own transaction (e.g. Better Auth's
 * `user.create.after` hook, which doesn't surface its tx to us) can hand
 * the wrapped client to repository code without rebuilding the adapter
 * inline. Inside the wrapper, `transaction` and `withUserTx` re-use the
 * same connection — they don't open a new one — because the caller owns
 * the BEGIN/COMMIT.
 */
function wrapPoolClient(client: PoolClient): DbClient {
  return {
    async query(sql, params) {
      const result = await client.query(sql, params);
      return result.rows;
    },
    async queryOne(sql, params) {
      const result = await client.query(sql, params);
      return result.rows[0] ?? null;
    },
    async execute(sql, params) {
      const result = await client.query(sql, params);
      return { rowCount: result.rowCount ?? 0 };
    },
    async transaction(fn) {
      return fn(wrapPoolClient(client));
    },
    async withUserTx(userId, fn, opts) {
      // Nested call: we are already inside a transaction. Refuse to switch
      // identity mid-transaction — that would silently mix two users'
      // writes under one set of RLS-bypassing GUCs. If the caller is
      // re-entering with the same userId, fall through and just re-run fn
      // on the same client (the GUC is already correct).
      if (opts?.isolation) {
        throw new Error(
          "isolation option not supported for nested withUserTx (must be set on outer tx)",
        );
      }
      const result = await client.query(
        "SELECT current_setting('app.user_id', true) AS uid",
      );
      const currentUid = (result.rows[0]?.uid ?? "") as string;
      if (currentUid && currentUid !== userId) {
        throw new Error(
          `nested withUserTx with different userId (current=${currentUid}, requested=${userId})`,
        );
      }
      if (!currentUid) {
        // Outer transaction did not set app.user_id (e.g. plain
        // `transaction(...)` wrapping a `withUserTx(...)`). Set it now.
        await client.query("SELECT set_config('app.user_id', $1, true)", [
          userId,
        ]);
      }
      return fn(brandAsUserTx(wrapPoolClient(client)));
    },
    async withUserWriteTx(userId, fn, opts) {
      if (opts?.isolation) {
        throw new Error(
          "isolation option not supported with withUserWriteTx (lock + non-default isolation needs an explicit retry layer)",
        );
      }
      // Re-acquire the advisory lock even though the outer tx may already
      // hold it: xact_lock is reference-counted, so this is harmless if the
      // outer was already a writer, and load-bearing if the outer was a
      // plain transaction or a read-only withUserTx (otherwise the writer
      // would silently run unlocked).
      return this.withUserTx(userId, async (tx) => {
        await tx.execute(ADVISORY_USER_LOCK_SQL, [userId]);
        return fn(brandAsUserWriteTx(tx));
      });
    },
    async ping() {
      await client.query("SELECT 1");
    },
  };
}

export function createDbClient(connectionString: string): DbClient {
  const pool = new pg.Pool({ connectionString });
  pool.on("error", (error) => {
    logError("db.pool", "idle_client_error", {}, error);
  });

  return {
    async query(sql, params) {
      const result = await pool.query(sql, params);
      return result.rows;
    },
    async queryOne(sql, params) {
      const result = await pool.query(sql, params);
      return result.rows[0] ?? null;
    },
    async execute(sql, params) {
      const result = await pool.query(sql, params);
      return { rowCount: result.rowCount ?? 0 };
    },
    async ping() {
      await pool.query("SELECT 1");
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(wrapPoolClient(client));
        await client.query("COMMIT");
        return result;
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackErr) {
          logWarn(
            "db.transaction",
            "rollback_failed",
            { reason: "connection may be broken" },
            rollbackErr,
          );
        }
        throw e;
      } finally {
        client.release();
      }
    },
    async withUserTx(userId, fn, opts) {
      return runUserTx(pool, userId, fn, opts, brandAsUserTx, false);
    },
    async withUserWriteTx(userId, fn, opts) {
      if (opts?.isolation) {
        throw new Error(
          "isolation option not supported with withUserWriteTx (lock + non-default isolation needs an explicit retry layer)",
        );
      }
      return runUserTx(pool, userId, fn, opts, brandAsUserWriteTx, true);
    },
  };
}

// Generic over the brand returned by `brander` so the same machinery
// serves both `withUserTx` (WithinUserTx) and `withUserWriteTx`
// (WithinUserWriteTx). `lockUser` is independent of the brand because
// the brand encodes "lock held" while `lockUser` actually acquires it.
async function runUserTx<T, Brand extends WithinUserTx>(
  pool: pg.Pool,
  userId: string,
  fn: (tx: Brand) => Promise<T>,
  opts: { isolation?: "repeatable read" | "serializable" } | undefined,
  brander: (client: DbClient) => Brand,
  lockUser: boolean,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (opts?.isolation) {
      // Must precede the first DML/SELECT in the transaction.
      // Whitelist values to avoid SQL injection — opts is a typed enum.
      const level =
        opts.isolation === "serializable" ? "SERIALIZABLE" : "REPEATABLE READ";
      await client.query(`SET TRANSACTION ISOLATION LEVEL ${level}`);
    }
    // Transaction-local GUC: third arg `true` scopes to current tx so
    // it's automatically reset on COMMIT / ROLLBACK and never leaks to
    // the next caller of this pooled connection.
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    if (lockUser) {
      // Released automatically on COMMIT/ROLLBACK (xact-scoped).
      // hashtextextended → bigint so a UUID-shaped userId fits the
      // 1-arg pg_advisory_xact_lock signature.
      await client.query(ADVISORY_USER_LOCK_SQL, [userId]);
    }
    const result = await fn(brander(wrapPoolClient(client)));
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      logWarn(
        "db.withUserTx",
        "rollback_failed",
        { reason: "connection may be broken" },
        rollbackErr,
      );
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Wrap a raw `pg.PoolClient` as a `WithinUserTx`, verifying that the
 * client's current transaction has `app.user_id` set to the expected
 * userId before returning. Use this from Better Auth hooks (e.g.
 * `user.create.after`) where Better Auth owns the BEGIN/COMMIT and we
 * cannot re-enter `withUserTx`.
 *
 * Throws if `app.user_id` is unset or does not match. This is a runtime
 * check, not a type-level assertion — it is the only way to safely cross
 * the boundary from a caller-owned tx into our RLS-aware repositories.
 */
export async function wrapUserTxPoolClient(
  client: PoolClient,
  userId: string,
): Promise<WithinUserTx> {
  const result = await client.query(
    "SELECT current_setting('app.user_id', true) AS uid",
  );
  const currentUid = (result.rows[0]?.uid ?? "") as string;
  if (!currentUid) {
    throw new Error(
      "wrapUserTxPoolClient: app.user_id is not set on this transaction",
    );
  }
  if (currentUid !== userId) {
    throw new Error(
      `wrapUserTxPoolClient: app.user_id mismatch (current=${currentUid}, requested=${userId})`,
    );
  }
  return brandAsUserTx(wrapPoolClient(client));
}
