// pg.Pool shim around a PGlite instance.
//
// Better Auth's adapter detection treats any object with a `.connect()` method
// as a node-postgres pool (Kysely's PostgresDialect). It only needs:
//   - pool.connect() → client
//   - client.query(sql, params) → { command, rowCount, rows }
//   - client.release()
//
// PGlite exposes nearly the same shape via `db.query` (which returns
// `{ rows, affectedRows }` and is fully serial). Wrapping it lets the
// integration-test Better Auth instance read/write the same in-memory DB the
// rest of the test fixtures use, so seeded users / sessions stay coherent.
//
// Caveats kept intentional: no real connection lifecycle, `.release()` is a
// no-op, `.end()` is a no-op. PGlite is single-process so transactions are
// already serialized.

import type { PGlite } from "@electric-sql/pglite";

interface PgQueryResult {
  command: string;
  rowCount: number;
  rows: unknown[];
}

function inferCommand(sql: string): string {
  const trimmed = sql.trimStart().toUpperCase();
  for (const cmd of [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
  ]) {
    if (trimmed.startsWith(cmd)) return cmd;
  }
  return trimmed.split(/\s+/)[0] ?? "QUERY";
}

export function createPgPoolFromPGlite(db: PGlite) {
  const exec = async (
    sql: string,
    params?: unknown[],
  ): Promise<PgQueryResult> => {
    const result = await db.query(sql, params);
    return {
      command: inferCommand(sql),
      rowCount: result.affectedRows ?? result.rows.length ?? 0,
      rows: result.rows as unknown[],
    };
  };

  const client = {
    query: exec,
    release: () => {},
  };

  return {
    connect: async () => client,
    query: exec,
    end: async () => {},
    on: () => {},
  };
}
