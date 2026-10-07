import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UserRepository } from "~/lib/auth/user-repository.server";
import {
  asTestTx,
  cleanTestEnv,
  createTestEnv,
  disposeTestEnv,
  type TestEnv,
} from "~/test/integration-helpers";

let testEnv: TestEnv;
let repo: UserRepository;
let tx: ReturnType<typeof asTestTx>;
const USER_ID = "user_repo_test";
const EMAIL = "user_repo_test@test.local";
const CREATED_AT = "2026-01-01T00:00:00.000Z";

beforeAll(async () => {
  testEnv = await createTestEnv();
  tx = asTestTx(testEnv.db);
});

afterAll(async () => {
  await disposeTestEnv(testEnv);
});

beforeEach(async () => {
  await cleanTestEnv(testEnv);
  repo = new UserRepository(testEnv.db);
});

describe("create + getById", () => {
  it("creates a user and fetches it by id", async () => {
    await repo.create(USER_ID, EMAIL, CREATED_AT, tx);

    const user = await repo.getById(USER_ID, tx);
    expect(user).not.toBeNull();
    expect(user?.id).toBe(USER_ID);
    expect(user?.email).toBe(EMAIL);
    expect(user?.storage_limit_bytes).toBe(0);
    expect(user?.grant_limit).toBe(0);
    expect(user?.revision_limit).toBe(0);
    expect(user?.bytes_used).toBe(0);
  });

  it("returns null for non-existent user", async () => {
    const user = await repo.getById("no_such_user", tx);
    expect(user).toBeNull();
  });
});

describe("getQuotaInfo", () => {
  it("returns limits and bytes_used", async () => {
    await repo.create(USER_ID, EMAIL, CREATED_AT, tx);

    const info = await repo.getQuotaInfo(USER_ID, tx);
    expect(info).toEqual({
      bytes_used: 0,
      storage_limit_bytes: 0,
      grant_limit: 0,
      revision_limit: 0,
    });
  });

  it("returns null for non-existent user", async () => {
    const info = await repo.getQuotaInfo("no_such_user", tx);
    expect(info).toBeNull();
  });
});

describe("addBytesUsed", () => {
  it("adds positive delta", async () => {
    await repo.create(USER_ID, EMAIL, CREATED_AT, tx);

    await repo.addBytesUsed(1000, USER_ID, tx);
    const info = await repo.getQuotaInfo(USER_ID, tx);
    expect(info?.bytes_used).toBe(1000);
  });

  it("adds multiple deltas cumulatively", async () => {
    await repo.create(USER_ID, EMAIL, CREATED_AT, tx);

    await repo.addBytesUsed(500, USER_ID, tx);
    await repo.addBytesUsed(300, USER_ID, tx);
    const info = await repo.getQuotaInfo(USER_ID, tx);
    expect(info?.bytes_used).toBe(800);
  });

  it("subtracts with negative delta", async () => {
    await repo.create(USER_ID, EMAIL, CREATED_AT, tx);

    await repo.addBytesUsed(1000, USER_ID, tx);
    await repo.addBytesUsed(-400, USER_ID, tx);
    const info = await repo.getQuotaInfo(USER_ID, tx);
    expect(info?.bytes_used).toBe(600);
  });

  it("clamps to zero with GREATEST(0, ...) when delta exceeds usage", async () => {
    await repo.create(USER_ID, EMAIL, CREATED_AT, tx);

    await repo.addBytesUsed(100, USER_ID, tx);
    await repo.addBytesUsed(-500, USER_ID, tx);
    const info = await repo.getQuotaInfo(USER_ID, tx);
    expect(info?.bytes_used).toBe(0);
  });
});

describe("setBytesUsed", () => {
  it("sets bytes_used to an absolute value", async () => {
    await repo.create(USER_ID, EMAIL, CREATED_AT, tx);

    await repo.setBytesUsed(4096, USER_ID, tx);
    const info = await repo.getQuotaInfo(USER_ID, tx);
    expect(info?.bytes_used).toBe(4096);
  });

  it("overwrites previous value", async () => {
    await repo.create(USER_ID, EMAIL, CREATED_AT, tx);

    await repo.setBytesUsed(4096, USER_ID, tx);
    await repo.setBytesUsed(0, USER_ID, tx);
    const info = await repo.getQuotaInfo(USER_ID, tx);
    expect(info?.bytes_used).toBe(0);
  });
});

describe("delete", () => {
  it("removes the user", async () => {
    await repo.create(USER_ID, EMAIL, CREATED_AT, tx);

    await repo.delete(USER_ID);

    const user = await repo.getById(USER_ID, tx);
    expect(user).toBeNull();
  });

  it("is a no-op for non-existent user", async () => {
    await repo.delete("no_such_user");
  });
});
