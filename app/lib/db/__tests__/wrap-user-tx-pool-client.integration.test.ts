// Runtime contract for `wrapUserTxPoolClient`.
//
// Better Auth hooks (e.g. `user.create.after`) own their own pg.Pool
// transaction and hand us a raw PoolClient. We need a verified way to
// cross that boundary into our RLS-aware repositories: `wrapUserTxPoolClient`
// is that bridge, and it must throw — not silently brand — when the caller's
// transaction is missing or has the wrong `app.user_id`. Without that runtime
// check, the brand on the type would be a polite suggestion, not a fence.

import type { PoolClient } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { wrapUserTxPoolClient } from "~/lib/db/client.server";
import { createPGliteDb } from "~/test/pglite-db";
import { createPgPoolFromPGlite } from "~/test/pglite-pg-pool";

// pglite-pg-pool's client shim implements .query and .release — enough for
// wrapUserTxPoolClient (which only calls .query). Cast through unknown so
// we match the pg.PoolClient type without dragging in the full interface.
async function withPoolClient<T>(
  // biome-ignore lint/suspicious/noExplicitAny: pglite shim
  pool: { connect: () => Promise<any> },
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client as unknown as PoolClient);
  } finally {
    client.release?.();
  }
}

describe("wrapUserTxPoolClient", () => {
  // biome-ignore lint/suspicious/noExplicitAny: pglite shim
  let pool: any;

  beforeAll(async () => {
    const db = await createPGliteDb();
    // biome-ignore lint/suspicious/noExplicitAny: pglite handle stash
    const pglite = (db as any).__pglite;
    pool = createPgPoolFromPGlite(pglite);
  });

  it("returns a WithinUserTx when app.user_id matches the requested userId", async () => {
    const userId = "u_match";
    await withPoolClient(pool, async (client) => {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.user_id', $1, true)", [
        userId,
      ]);
      const tx = await wrapUserTxPoolClient(client, userId);
      expect(tx).toBeDefined();
      // Type-level: tx is WithinUserTx (covered by within-user-tx.test-d.ts).
      // Runtime: the wrapped client must be usable as a DbClient.
      const row = await tx.queryOne<{ uid: string | null }>(
        "SELECT current_setting('app.user_id', true) AS uid",
      );
      expect(row?.uid).toBe(userId);
      await client.query("ROLLBACK");
    });
  });

  it("throws when app.user_id is unset on the transaction", async () => {
    await withPoolClient(pool, async (client) => {
      await client.query("BEGIN");
      // Intentionally do NOT set app.user_id.
      await expect(wrapUserTxPoolClient(client, "u_any")).rejects.toThrow(
        /app\.user_id is not set/,
      );
      await client.query("ROLLBACK");
    });
  });

  it("throws when app.user_id is set but does not match the requested userId", async () => {
    await withPoolClient(pool, async (client) => {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.user_id', $1, true)", [
        "u_actual",
      ]);
      await expect(wrapUserTxPoolClient(client, "u_different")).rejects.toThrow(
        /mismatch.*current=u_actual.*requested=u_different/,
      );
      await client.query("ROLLBACK");
    });
  });
});
