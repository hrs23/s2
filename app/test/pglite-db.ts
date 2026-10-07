// PGlite-based DbClient for integration tests.
// Each call to createPGliteDb() creates a fresh in-memory PGlite instance
// with all migrations applied — no Docker/Postgres service needed.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type {
  DbClient,
  WithinUserTx,
  WithinUserWriteTx,
} from "~/lib/db/client.server";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");

/** Strip dbmate markers and the migrate:down section from SQL. */
function extractUpSection(sql: string): string {
  const downIdx = sql.indexOf("-- migrate:down");
  const upSql = downIdx >= 0 ? sql.slice(0, downIdx) : sql;
  // Remove -- migrate:up marker line itself
  return upSql.replace(/^--\s*migrate:up\s*\n?/m, "");
}

async function runMigrations(db: PGlite): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const raw = await readFile(join(MIGRATIONS_DIR, file), "utf-8");
    const sql = extractUpSection(raw).trim();
    if (sql) {
      await db.exec(sql);
    }
  }
}

function wrapPGlite(db: PGlite): DbClient {
  const client: DbClient = {
    async query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
      const result = await db.query<T>(sql, params);
      return result.rows;
    },

    async queryOne<T = unknown>(
      sql: string,
      params?: unknown[],
    ): Promise<T | null> {
      const result = await db.query<T>(sql, params);
      return result.rows[0] ?? null;
    },

    async execute(
      sql: string,
      params?: unknown[],
    ): Promise<{ rowCount: number }> {
      const result = await db.query(sql, params);
      return { rowCount: result.affectedRows ?? 0 };
    },

    async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
      return db.transaction(async (tx) => {
        const txClient: DbClient = {
          async query<U = unknown>(sql: string, p?: unknown[]): Promise<U[]> {
            const r = await tx.query<U>(sql, p);
            return r.rows;
          },
          async queryOne<U = unknown>(
            sql: string,
            p?: unknown[],
          ): Promise<U | null> {
            const r = await tx.query<U>(sql, p);
            return r.rows[0] ?? null;
          },
          async execute(
            sql: string,
            p?: unknown[],
          ): Promise<{ rowCount: number }> {
            const r = await tx.query(sql, p);
            return { rowCount: r.affectedRows ?? 0 };
          },
          async transaction<V>(
            innerFn: (inner: DbClient) => Promise<V>,
          ): Promise<V> {
            // PGlite nested transactions use savepoints automatically
            return innerFn(txClient);
          },
          async withUserTx<V>(
            userId: string,
            innerFn: (inner: WithinUserTx) => Promise<V>,
            opts?: { isolation?: "repeatable read" | "serializable" },
          ): Promise<V> {
            if (opts?.isolation) {
              throw new Error(
                "isolation option not supported for nested withUserTx",
              );
            }
            const r = await tx.query<{ uid: string | null }>(
              "SELECT current_setting('app.user_id', true) AS uid",
            );
            const currentUid = (r.rows[0]?.uid ?? "") as string;
            if (currentUid && currentUid !== userId) {
              throw new Error(
                `nested withUserTx with different userId (current=${currentUid}, requested=${userId})`,
              );
            }
            if (!currentUid) {
              await tx.query("SELECT set_config('app.user_id', $1, true)", [
                userId,
              ]);
            }
            return innerFn(txClient as WithinUserTx);
          },
          async withUserWriteTx<V>(
            userId: string,
            innerFn: (inner: WithinUserWriteTx) => Promise<V>,
            opts?: { isolation?: "repeatable read" | "serializable" },
          ): Promise<V> {
            if (opts?.isolation) {
              throw new Error(
                "isolation option not supported with withUserWriteTx",
              );
            }
            return txClient.withUserTx(userId, (innerTx) =>
              innerFn(innerTx as WithinUserWriteTx),
            );
          },
          async ping(): Promise<void> {
            await tx.query("SELECT 1");
          },
        };
        return fn(txClient);
      });
    },

    async withUserTx<T>(
      userId: string,
      fn: (tx: WithinUserTx) => Promise<T>,
      opts?: { isolation?: "repeatable read" | "serializable" },
    ): Promise<T> {
      return client.transaction(async (tx) => {
        if (opts?.isolation) {
          const level =
            opts.isolation === "serializable"
              ? "SERIALIZABLE"
              : "REPEATABLE READ";
          await tx.query(`SET TRANSACTION ISOLATION LEVEL ${level}`);
        }
        await tx.query("SELECT set_config('app.user_id', $1, true)", [userId]);
        return fn(tx as WithinUserTx);
      });
    },

    async withUserWriteTx<T>(
      userId: string,
      fn: (tx: WithinUserWriteTx) => Promise<T>,
      opts?: { isolation?: "repeatable read" | "serializable" },
    ): Promise<T> {
      if (opts?.isolation) {
        throw new Error("isolation option not supported with withUserWriteTx");
      }
      // PGlite is single-connection in-memory; concurrent writers are
      // serialized at the engine level. The advisory-lock contract only
      // matters against real Postgres, where real concurrency happens.
      return client.withUserTx(userId, (innerTx) =>
        fn(innerTx as WithinUserWriteTx),
      );
    },

    async ping(): Promise<void> {
      await db.query("SELECT 1");
    },
  };

  return client;
}

/**
 * Creates a fresh PGlite in-memory instance with all migrations applied.
 * Each call is fully isolated — safe to call once per test file or test.
 */
export async function createPGliteDb(): Promise<DbClient> {
  const db = new PGlite();
  await runMigrations(db);
  const wrapped = wrapPGlite(db);
  // Stash the raw PGlite handle so integration-test code that needs a
  // node-postgres-shaped Pool (Better Auth) can build one over the same
  // in-memory DB. See app/test/pglite-pg-pool.ts.
  (wrapped as DbClient & { __pglite?: PGlite }).__pglite = db;
  return wrapped;
}
