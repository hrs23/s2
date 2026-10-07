import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TxRollbackError } from "./tx-error";

// biome-ignore lint/suspicious/noExplicitAny: test internals
let mockQuery: any;
// biome-ignore lint/suspicious/noExplicitAny: test internals
let mockRelease: any;
// biome-ignore lint/suspicious/noExplicitAny: test internals
let mockPoolOn: any = vi.fn();

vi.mock("pg", () => {
  function MockPool() {
    return {
      connect: vi.fn().mockImplementation(async () => ({
        query: (...args: unknown[]) => mockQuery(...args),
        release: (...args: unknown[]) => mockRelease(...args),
      })),
      query: vi.fn(),
      on: (...args: unknown[]) => mockPoolOn(...args),
    };
  }

  return {
    default: {
      Pool: MockPool,
      types: { setTypeParser: vi.fn() },
    },
  };
});

describe("createDbClient transaction", () => {
  beforeEach(() => {
    mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    mockRelease = vi.fn();
    mockPoolOn = vi.fn();
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function makeDb() {
    const { createDbClient } = await import("./client.server");
    return createDbClient("postgres://test");
  }

  it("registers a pool error handler that does not throw", async () => {
    await makeDb();
    const call = mockPoolOn.mock.calls.find((c: unknown[]) => c[0] === "error");
    expect(call).toBeDefined();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => call[1](new Error("idle drop"))).not.toThrow();
    spy.mockRestore();
  });

  it("returns result and commits on success", async () => {
    const db = await makeDb();

    const result = await db.transaction(async () => 42);

    expect(result).toBe(42);
    expect(mockQuery).toHaveBeenCalledWith("BEGIN");
    expect(mockQuery).toHaveBeenCalledWith("COMMIT");
    expect(mockRelease).toHaveBeenCalled();
  });

  it("rethrows original error when fn throws and ROLLBACK succeeds", async () => {
    const db = await makeDb();

    const originalError = new Error("original error");
    await expect(
      db.transaction(async () => {
        throw originalError;
      }),
    ).rejects.toThrow("original error");

    expect(mockQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(mockRelease).toHaveBeenCalled();
  });

  it("rolls back when TxRollbackError is thrown", async () => {
    const db = await makeDb();

    const result = await db
      .transaction(async () => {
        throw new TxRollbackError("conflict");
      })
      .catch(TxRollbackError.into);

    expect(result).toEqual({ ok: false, code: "conflict" });
    expect(mockQuery).toHaveBeenCalledWith("BEGIN");
    expect(mockQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(mockQuery).not.toHaveBeenCalledWith("COMMIT");
    expect(mockRelease).toHaveBeenCalled();
  });

  it("TxRollbackError.into re-throws non-TxRollbackError", async () => {
    const db = await makeDb();

    await expect(
      db
        .transaction(async () => {
          throw new Error("unexpected");
        })
        .catch(TxRollbackError.into),
    ).rejects.toThrow("unexpected");
  });

  it("rethrows original error even when ROLLBACK also throws", async () => {
    const rollbackError = new Error("ECONNRESET");
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockRejectedValueOnce(rollbackError); // ROLLBACK fails
    const db = await makeDb();

    const originalError = new Error("original error");
    await expect(
      db.transaction(async () => {
        throw originalError;
      }),
    ).rejects.toThrow("original error");

    expect(mockRelease).toHaveBeenCalled();
  });
});

describe("createDbClient withUserTx", () => {
  beforeEach(() => {
    mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    mockRelease = vi.fn();
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function makeDb() {
    const { createDbClient } = await import("./client.server");
    return createDbClient("postgres://test");
  }

  const USER_ID = "11111111-2222-3333-4444-555555555555";

  it("issues BEGIN -> set_config('app.user_id', userId, true) -> COMMIT in order", async () => {
    const db = await makeDb();

    const result = await db.withUserTx(USER_ID, async () => "ok");

    expect(result).toBe("ok");

    const statements = mockQuery.mock.calls.map(
      (args: unknown[]) => args[0] as string,
    );
    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toBe("SELECT set_config('app.user_id', $1, true)");
    // Last statement must be COMMIT (order matters for RLS correctness).
    expect(statements[statements.length - 1]).toBe("COMMIT");
    expect(statements).not.toContain("ROLLBACK");

    // userId must be passed as a parameter, never interpolated.
    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      "SELECT set_config('app.user_id', $1, true)",
      [USER_ID],
    );

    expect(mockRelease).toHaveBeenCalled();
  });

  it("rolls back and rethrows when callback throws", async () => {
    const db = await makeDb();

    const boom = new Error("callback failed");
    await expect(
      db.withUserTx(USER_ID, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const statements = mockQuery.mock.calls.map(
      (args: unknown[]) => args[0] as string,
    );
    expect(statements).toContain("BEGIN");
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(mockRelease).toHaveBeenCalled();
  });

  it("rolls back when set_config itself fails", async () => {
    // app.user_id is set as text via set_config; the failure mode this
    // test exercises is set_config raising a generic server-side error
    // (e.g. connection lost mid-statement). The callback must not run
    // and the transaction must roll back.
    const setConfigError = new Error("connection terminated unexpectedly");
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockRejectedValueOnce(setConfigError); // set_config

    const db = await makeDb();
    const fn = vi.fn();

    await expect(db.withUserTx(USER_ID, fn)).rejects.toThrow(
      "connection terminated unexpectedly",
    );

    expect(fn).not.toHaveBeenCalled();
    const statements = mockQuery.mock.calls.map(
      (args: unknown[]) => args[0] as string,
    );
    expect(statements).toContain("ROLLBACK");
    expect(mockRelease).toHaveBeenCalled();
  });

  it("rethrows original error even when ROLLBACK also throws", async () => {
    const rollbackError = new Error("ECONNRESET");
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // set_config
      .mockRejectedValueOnce(rollbackError); // ROLLBACK fails (after callback throws)
    const db = await makeDb();

    const originalError = new Error("original");
    await expect(
      db.withUserTx(USER_ID, async () => {
        throw originalError;
      }),
    ).rejects.toBe(originalError);

    expect(mockRelease).toHaveBeenCalled();
  });

  it("nested withUserTx (inside a plain transaction with no GUC) sets GUC without opening a new BEGIN", async () => {
    // current_setting('app.user_id', true) returns empty -> rows[0].uid is
    // null -> wrapper treats it as "outer tx did not set user_id" and
    // issues set_config exactly once.
    mockQuery = vi
      .fn()
      .mockImplementation(async (sql: string, _params?: unknown[]) => {
        if (sql.includes("current_setting('app.user_id'")) {
          return { rows: [{ uid: null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

    const db = await makeDb();

    await db.transaction(async (tx) => {
      await tx.withUserTx(USER_ID, async () => "inner");
    });

    const statements = mockQuery.mock.calls.map(
      (args: unknown[]) => args[0] as string,
    );
    // Outer transaction opens BEGIN/COMMIT exactly once; nested withUserTx
    // must NOT issue its own BEGIN.
    expect(statements.filter((s: string) => s === "BEGIN")).toHaveLength(1);
    expect(statements.filter((s: string) => s === "COMMIT")).toHaveLength(1);
    expect(statements).toContain("SELECT set_config('app.user_id', $1, true)");
  });

  it("nested withUserTx with the SAME userId is a no-op (does not re-set GUC)", async () => {
    // current_setting returns the same userId -> wrapper skips set_config
    // and just runs fn on the existing client.
    mockQuery = vi
      .fn()
      .mockImplementation(async (sql: string, _params?: unknown[]) => {
        if (sql.includes("current_setting('app.user_id'")) {
          return { rows: [{ uid: USER_ID }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

    const db = await makeDb();

    await db.transaction(async (tx) => {
      await tx.withUserTx(USER_ID, async () => "inner");
    });

    const statements = mockQuery.mock.calls.map(
      (args: unknown[]) => args[0] as string,
    );
    // No nested set_config — the GUC is already correct.
    expect(
      statements.filter(
        (s: string) => s === "SELECT set_config('app.user_id', $1, true)",
      ),
    ).toHaveLength(0);
    expect(statements.filter((s: string) => s === "BEGIN")).toHaveLength(1);
    expect(statements.filter((s: string) => s === "COMMIT")).toHaveLength(1);
  });

  it("withUserWriteTx issues advisory lock after set_config and before fn", async () => {
    // Lock must come AFTER set_config (so the RLS GUC is in place when the
    // lock is observed) and BEFORE the user fn runs (so concurrent writers
    // wait at the tx boundary, not mid-operation).
    const { ADVISORY_USER_LOCK_SQL } = await import("./client.server");
    const db = await makeDb();

    const callIndexAtFnStart: { value: number } = { value: -1 };
    const fn = vi.fn(async () => {
      callIndexAtFnStart.value = mockQuery.mock.calls.length;
      return "ok";
    });

    const result = await db.withUserWriteTx(USER_ID, fn);

    expect(result).toBe("ok");

    const statements = mockQuery.mock.calls.map(
      (args: unknown[]) => args[0] as string,
    );
    const setConfigIdx = statements.indexOf(
      "SELECT set_config('app.user_id', $1, true)",
    );
    const lockIdx = statements.indexOf(ADVISORY_USER_LOCK_SQL);
    expect(setConfigIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBe(setConfigIdx + 1);
    expect(lockIdx).toBeLessThan(callIndexAtFnStart.value);

    expect(mockQuery).toHaveBeenCalledWith(ADVISORY_USER_LOCK_SQL, [USER_ID]);
  });

  it("withUserTx (read path) does NOT acquire the advisory lock", async () => {
    const { ADVISORY_USER_LOCK_SQL } = await import("./client.server");
    const db = await makeDb();

    await db.withUserTx(USER_ID, async () => "ok");

    const statements = mockQuery.mock.calls.map(
      (args: unknown[]) => args[0] as string,
    );
    expect(statements).not.toContain(ADVISORY_USER_LOCK_SQL);
  });

  it("nested withUserTx with a DIFFERENT userId throws (refuses identity switch)", async () => {
    const OTHER_USER = "99999999-8888-7777-6666-555555555555";
    mockQuery = vi
      .fn()
      .mockImplementation(async (sql: string, _params?: unknown[]) => {
        if (sql.includes("current_setting('app.user_id'")) {
          return { rows: [{ uid: USER_ID }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

    const db = await makeDb();

    await expect(
      db.transaction(async (tx) => {
        await tx.withUserTx(OTHER_USER, async () => "inner");
      }),
    ).rejects.toThrow("nested withUserTx with different userId");

    const statements = mockQuery.mock.calls.map(
      (args: unknown[]) => args[0] as string,
    );
    // Outer transaction must roll back so no partial writes leak.
    expect(statements).toContain("ROLLBACK");
    // The nested wrapper must NOT have called set_config under the wrong
    // identity.
    expect(
      statements.filter(
        (s: string) => s === "SELECT set_config('app.user_id', $1, true)",
      ),
    ).toHaveLength(0);
    expect(mockRelease).toHaveBeenCalled();
  });
});
