// Integration test for QuotaService against a real PG-backed UserRepository
// + TokenRepository. RLS prerequisite: lock down the current
// manual `WHERE user_id` discipline with cross-user assertions before we let
// Postgres enforce it. If user B can see/mutate user A's quota state through
// any QuotaService method, the test fails.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QuotaService } from "~/lib/auth/quota-service.server";
import { TokenRepository } from "~/lib/auth/token-repository.server";
import { UserRepository } from "~/lib/auth/user-repository.server";
import type { DbClient } from "~/lib/db/client.server";
import {
  asTestTx,
  cleanTestEnv,
  createTestEnv,
  createTestUser,
  disposeTestEnv,
  FINITE_TEST_LIMITS,
  issueTestToken,
  type TestEnv,
  type TestUser,
} from "~/test/integration-helpers";

let tx: ReturnType<typeof asTestTx>;

let testEnv: TestEnv;
let db: DbClient;
let quota: QuotaService;
let userRepo: UserRepository;
let tokenRepo: TokenRepository;

beforeAll(async () => {
  testEnv = await createTestEnv();
  db = testEnv.db;
  tx = asTestTx(db);
});

afterAll(async () => {
  await disposeTestEnv(testEnv);
});

beforeEach(async () => {
  await cleanTestEnv(testEnv);
  userRepo = new UserRepository(db);
  tokenRepo = new TokenRepository(db);
  quota = new QuotaService(userRepo, tokenRepo);
});

describe("QuotaService.checkStorage (real DB)", () => {
  it("reads the user's own limits and bytes_used", async () => {
    const u = await createTestUser(db, {
      limits: {
        storage_limit_bytes: 10 * 1024 * 1024 * 1024,
        grant_limit: 100,
        revision_limit: 30,
      },
    });
    await userRepo.addBytesUsed(2048, u.id, tx);

    const r = await quota.checkStorage(u.id, 1024, tx);
    expect(r.used).toBe(2048);
    expect(r.limit).toBe(10 * 1024 * 1024 * 1024);
    expect(r.allowed).toBe(true);
  });

  it("blocks when adding additionalBytes would exceed limit", async () => {
    const u = await createTestUser(db, { limits: FINITE_TEST_LIMITS });
    await userRepo.setBytesUsed(
      FINITE_TEST_LIMITS.storage_limit_bytes - 10,
      u.id,
      tx,
    );

    const r = await quota.checkStorage(u.id, 100, tx);
    expect(r.allowed).toBe(false);
  });

  it("falls back to unlimited for an unknown user id", async () => {
    const r = await quota.checkStorage("user_nonexistent", 100, tx);
    expect(r.used).toBe(0);
    expect(r.limit).toBe(0);
    expect(r.allowed).toBe(true);
  });

  it("does NOT leak user A's bytes_used into user B's checkStorage", async () => {
    const a = await createTestUser(db, { limits: FINITE_TEST_LIMITS });
    const b = await createTestUser(db, { limits: FINITE_TEST_LIMITS });

    await userRepo.setBytesUsed(200 * 1024 * 1024, a.id, tx);

    const ra = await quota.checkStorage(a.id, 0, tx);
    const rb = await quota.checkStorage(b.id, 0, tx);

    expect(ra.used).toBe(200 * 1024 * 1024);
    expect(rb.used).toBe(0);
  });

  it("does NOT leak user A's limits into user B's checkStorage", async () => {
    const a = await createTestUser(db, {
      limits: {
        storage_limit_bytes: 1024 * 1024 * 1024 * 1024,
        grant_limit: 100,
        revision_limit: 30,
      },
    });
    const b = await createTestUser(db, { limits: FINITE_TEST_LIMITS });

    const ra = await quota.checkStorage(a.id, 0, tx);
    const rb = await quota.checkStorage(b.id, 0, tx);

    expect(ra.limit).toBe(1024 * 1024 * 1024 * 1024);
    expect(rb.limit).toBe(FINITE_TEST_LIMITS.storage_limit_bytes);
  });
});

describe("QuotaService.updateBytesUsed (real DB)", () => {
  it("writes positive delta into the caller's user_storage row", async () => {
    const u = await createTestUser(db);
    await quota.updateBytesUsed(u.id, 1500, tx);
    const info = await userRepo.getQuotaInfo(u.id, tx);
    expect(info?.bytes_used).toBe(1500);
  });

  it("subtracts on negative delta", async () => {
    const u = await createTestUser(db);
    await quota.updateBytesUsed(u.id, 1000, tx);
    await quota.updateBytesUsed(u.id, -400, tx);
    const info = await userRepo.getQuotaInfo(u.id, tx);
    expect(info?.bytes_used).toBe(600);
  });

  it("is a no-op when delta = 0 (no DB write)", async () => {
    const u = await createTestUser(db, { limits: FINITE_TEST_LIMITS });
    await userRepo.setBytesUsed(123, u.id, tx);
    await quota.updateBytesUsed(u.id, 0, tx);
    const info = await userRepo.getQuotaInfo(u.id, tx);
    expect(info?.bytes_used).toBe(123);
  });

  it("update against user A does NOT touch user B's bytes_used", async () => {
    const a = await createTestUser(db);
    const b = await createTestUser(db);

    await quota.updateBytesUsed(a.id, 5000, tx);

    const aInfo = await userRepo.getQuotaInfo(a.id, tx);
    const bInfo = await userRepo.getQuotaInfo(b.id, tx);

    expect(aInfo?.bytes_used).toBe(5000);
    expect(bInfo?.bytes_used).toBe(0);
  });

  it("concurrent updateBytesUsed against different users does not cross-contaminate", async () => {
    const users: TestUser[] = await Promise.all([
      createTestUser(db),
      createTestUser(db),
      createTestUser(db),
    ]);

    const ops: Array<Promise<void>> = [];
    for (let i = 0; i < 50; i++) {
      for (const u of users) {
        ops.push(quota.updateBytesUsed(u.id, 10, tx));
      }
    }
    await Promise.all(ops);

    for (const u of users) {
      const info = await userRepo.getQuotaInfo(u.id, tx);
      expect(info?.bytes_used).toBe(500);
    }
  });

  it("concurrent updateBytesUsed on the same user does not lose increments", async () => {
    const u = await createTestUser(db);

    const N = 100;
    await Promise.all(
      Array.from({ length: N }, () => quota.updateBytesUsed(u.id, 7, tx)),
    );

    const info = await userRepo.getQuotaInfo(u.id, tx);
    expect(info?.bytes_used).toBe(N * 7);
  });
});

describe("QuotaService.setBytesUsed (real DB)", () => {
  it("sets an absolute value on the caller's row", async () => {
    const u = await createTestUser(db);
    await quota.setBytesUsed(u.id, 8192, tx);
    const info = await userRepo.getQuotaInfo(u.id, tx);
    expect(info?.bytes_used).toBe(8192);
  });

  it("setBytesUsed on user A does NOT overwrite user B's row", async () => {
    const a = await createTestUser(db);
    const b = await createTestUser(db);
    await userRepo.setBytesUsed(1234, b.id, tx);

    await quota.setBytesUsed(a.id, 9999, tx);

    const aInfo = await userRepo.getQuotaInfo(a.id, tx);
    const bInfo = await userRepo.getQuotaInfo(b.id, tx);
    expect(aInfo?.bytes_used).toBe(9999);
    expect(bInfo?.bytes_used).toBe(1234);
  });
});

describe("QuotaService.getUsage (real DB)", () => {
  it("returns the caller's used + limit + revision_limit", async () => {
    const u = await createTestUser(db, {
      limits: {
        storage_limit_bytes: 10 * 1024 * 1024 * 1024,
        grant_limit: 100,
        revision_limit: 30,
      },
    });
    await userRepo.setBytesUsed(4096, u.id, tx);

    const usage = await quota.getUsage(u.id, tx);
    expect(usage.used).toBe(4096);
    expect(usage.limit).toBe(10 * 1024 * 1024 * 1024);
    expect(usage.revision_limit).toBe(30);
  });

  it("falls back to unlimited for an unknown user id", async () => {
    const usage = await quota.getUsage("user_nonexistent", tx);
    expect(usage.used).toBe(0);
    expect(usage.limit).toBe(0);
    expect(usage.revision_limit).toBe(0);
  });

  it("getUsage(B) returns B's data even after A wrote a large value", async () => {
    const a = await createTestUser(db, {
      limits: {
        storage_limit_bytes: 1024 * 1024 * 1024 * 1024,
        grant_limit: 100,
        revision_limit: 30,
      },
    });
    const b = await createTestUser(db, { limits: FINITE_TEST_LIMITS });
    await userRepo.setBytesUsed(999_999_999, a.id, tx);

    const ub = await quota.getUsage(b.id, tx);
    expect(ub.used).toBe(0);
    expect(ub.limit).toBe(FINITE_TEST_LIMITS.storage_limit_bytes);
  });
});

describe("QuotaService.getGrantUsage (real DB)", () => {
  it("returns count of grants and the user's grant limit", async () => {
    const u = await createTestUser(db, {
      limits: {
        storage_limit_bytes: 0,
        grant_limit: 100,
        revision_limit: 30,
      },
    });
    await issueTestToken(db, { userId: u.id, name: "t1" });
    await issueTestToken(db, { userId: u.id, name: "t2" });

    const r = await quota.getGrantUsage(u.id, tx);
    expect(r.count).toBe(2);
    expect(r.limit).toBe(100);
  });

  it("count is 0 when user has no grants", async () => {
    const u = await createTestUser(db, { limits: FINITE_TEST_LIMITS });
    const r = await quota.getGrantUsage(u.id, tx);
    expect(r.count).toBe(0);
  });

  it("falls back to unlimited for unknown user id", async () => {
    const r = await quota.getGrantUsage("user_nonexistent", tx);
    expect(r.count).toBe(0);
    expect(r.limit).toBe(0);
  });

  it("getGrantUsage(B) does NOT count user A's tokens", async () => {
    const a = await createTestUser(db);
    const b = await createTestUser(db);
    await issueTestToken(db, { userId: a.id, name: "a1" });
    await issueTestToken(db, { userId: a.id, name: "a2" });
    await issueTestToken(db, { userId: a.id, name: "a3" });
    await issueTestToken(db, { userId: b.id, name: "b1" });

    const ra = await quota.getGrantUsage(a.id, tx);
    const rb = await quota.getGrantUsage(b.id, tx);

    expect(ra.count).toBe(3);
    expect(rb.count).toBe(1);
  });
});
