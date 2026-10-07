/**
 * Throw inside a `db.transaction()` callback to trigger ROLLBACK
 * while carrying a typed error code back to the caller.
 *
 * Usage:
 *   const result = await db.transaction(async (tx) => {
 *     if (!ok) throw new TxRollbackError("conflict");
 *     return { ok: true, ... };
 *   }).catch(TxRollbackError.into);
 */
export class TxRollbackError<C extends string = string> extends Error {
  readonly code: C;

  constructor(code: C) {
    super(`Transaction rolled back: ${code}`);
    this.code = code;
  }

  /**
   * Catch handler that converts TxRollbackError into `{ ok: false, code }`.
   * Re-throws all other errors.
   */
  static into<C extends string>(e: unknown): { ok: false; code: C } {
    if (e instanceof TxRollbackError) {
      return { ok: false, code: e.code as C };
    }
    throw e;
  }
}
