import { hashPassword } from "better-auth/crypto";
import pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSelfHostUser,
  setSelfHostUserPassword,
} from "./user-bootstrap.server";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  end: vi.fn(),
  Pool: vi.fn(),
}));

vi.mock("pg", () => ({
  default: {
    Pool: mocks.Pool,
  },
}));

vi.mock("better-auth/crypto", () => ({
  hashPassword: vi.fn(async (password: string) => `hashed:${password}`),
}));

describe("createSelfHostUser", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.release.mockReset();
    mocks.end.mockReset();
    mocks.Pool.mockReset();
    mocks.Pool.mockImplementation(function MockPool() {
      return {
        connect: async () => ({ query: mocks.query, release: mocks.release }),
        end: mocks.end,
      };
    });
    vi.mocked(hashPassword).mockClear();
  });

  it("creates the first user with unlimited user_limits defaults", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // existing user check
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 }) // count
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // insert user
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // insert account
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // insert user_limits
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // insert user_storage
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // insert grant
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // insert user_grants
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // insert grant_paths
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

    const result = await createSelfHostUser({
      databaseUrl: "postgres://example",
      email: " OWNER@Example.com ",
      password: "new-password",
      name: "  Owner  ",
    });

    expect(result.firstUser).toBe(true);
    expect(result.email).toBe("owner@example.com");
    expect(result.id).toMatch(/^user_/);
    expect(mocks.query).toHaveBeenCalledWith(
      "INSERT INTO user_limits (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
      [result.id],
    );
    expect(mocks.query).toHaveBeenCalledWith("COMMIT");
  });

  it("rejects duplicate emails", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: "user_existing" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(
      createSelfHostUser({
        databaseUrl: "postgres://example",
        email: "owner@example.com",
        password: "new-password",
      }),
    ).rejects.toThrow("User already exists: owner@example.com");

    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
  });
});

describe("setSelfHostUserPassword", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.release.mockReset();
    mocks.end.mockReset();
    mocks.Pool.mockReset();
    mocks.Pool.mockImplementation(function MockPool() {
      return {
        connect: async () => ({ query: mocks.query, release: mocks.release }),
        end: mocks.end,
      };
    });
    vi.mocked(hashPassword).mockClear();
  });

  it("updates the credential account password for the email", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: "user_1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(
      setSelfHostUserPassword({
        databaseUrl: "postgres://example",
        email: " OWNER@Example.com ",
        password: "new-password",
      }),
    ).resolves.toEqual({ id: "user_1", email: "owner@example.com" });

    expect(pg.Pool).toHaveBeenCalledWith({
      connectionString: "postgres://example",
      max: 1,
    });
    expect(hashPassword).toHaveBeenCalledWith("new-password");
    expect(mocks.query).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(mocks.query).toHaveBeenNthCalledWith(
      2,
      'SELECT id FROM "user" WHERE email = $1',
      ["owner@example.com"],
    );
    expect(mocks.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('UPDATE "account"'),
      ["hashed:new-password", expect.any(Date), "user_1"],
    );
    expect(mocks.query).toHaveBeenNthCalledWith(
      4,
      'DELETE FROM "session" WHERE "userId" = $1',
      ["user_1"],
    );
    expect(mocks.query).toHaveBeenNthCalledWith(5, "COMMIT");
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });

  it("rolls back when the email does not exist", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(
      setSelfHostUserPassword({
        databaseUrl: "postgres://example",
        email: "missing@example.com",
        password: "new-password",
      }),
    ).rejects.toThrow("User not found: missing@example.com");

    expect(mocks.query).toHaveBeenNthCalledWith(3, "ROLLBACK");
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });
});
