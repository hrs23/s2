// Compile-time contract: WithinUserTx / WithinUserWriteTx are non-forgeable
// brands. RLS depends on every RLS-table query going through a tx
// that has set `app.user_id`; the brand encodes that promise in the type
// system, so callers cannot "almost-accidentally" pass an unscoped DbClient
// where a user-scoped tx is required.
//
// This file is type-only — `expectError` lines are checked by `tsc` via the
// `types` vitest project (see vitest.config.ts). No runtime code runs.

import { expectTypeOf } from "vitest";
import type {
  DbClient,
  WithinUserTx,
  WithinUserWriteTx,
} from "~/lib/db/client.server";

// A function that demands a user-scoped tx (the shape every RLS repo
// method will take).
declare function rlsRepoMethod(tx: WithinUserTx): Promise<void>;
declare function rlsWriterRepoMethod(tx: WithinUserWriteTx): Promise<void>;

declare const plainDb: DbClient;
declare const userTx: WithinUserTx;
declare const writeTx: WithinUserWriteTx;

// 1. A plain DbClient is NOT assignable to WithinUserTx — this is the
//    whole point: callers can't pass `this.db` (unscoped) where the RLS
//    repo demands a user-scoped tx.
// @ts-expect-error — DbClient is missing the WithinUserTx brand
rlsRepoMethod(plainDb);

// 2. A WithinUserTx is fine.
rlsRepoMethod(userTx);

// 3. A WithinUserWriteTx is also fine (it extends WithinUserTx).
rlsRepoMethod(writeTx);

// 4. A WithinUserTx is NOT a WithinUserWriteTx — writer-only operations
//    must hold the advisory lock. Read-only tx must not be promotable to
//    writer at the type level.
// @ts-expect-error — WithinUserTx is missing the WithinUserWriteTx brand
rlsWriterRepoMethod(userTx);

// 5. WithinUserWriteTx satisfies the writer constraint.
rlsWriterRepoMethod(writeTx);

// 6. WithinUserTx still exposes the full DbClient surface (it extends it).
expectTypeOf(userTx).toMatchTypeOf<DbClient>();
expectTypeOf(writeTx).toMatchTypeOf<DbClient>();
expectTypeOf(writeTx).toMatchTypeOf<WithinUserTx>();

// 7. `withUserTx` callback receives WithinUserTx, not plain DbClient.
declare const db: DbClient;
db.withUserTx("u_1", async (tx) => {
  expectTypeOf(tx).toMatchTypeOf<WithinUserTx>();
});
db.withUserWriteTx("u_1", async (tx) => {
  expectTypeOf(tx).toMatchTypeOf<WithinUserWriteTx>();
});
