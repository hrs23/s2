import { describe, expect, it, vi } from "vitest";
import { QuotaService } from "~/lib/auth/quota-service.server";
import type { TokenRepository } from "~/lib/auth/token-repository.server";
import type {
  QuotaInfo,
  UserRepository,
} from "~/lib/auth/user-repository.server";
import { asMockTx, FINITE_TEST_LIMITS } from "~/test/integration-helpers";

// Pure unit test: mocks never actually consult `tx`. Brand-cast a placeholder
// so the type system accepts the calls.
const tx = asMockTx();

function makeTokenRepo(): TokenRepository {
  return {
    countByUser: vi.fn().mockResolvedValue(0),
  } as unknown as TokenRepository;
}

function makeRepo(info: QuotaInfo | null): UserRepository {
  return {
    getQuotaInfo: vi.fn().mockResolvedValue(info),
  } as unknown as UserRepository;
}

const finiteLimits: QuotaInfo = {
  bytes_used: 0,
  storage_limit_bytes: FINITE_TEST_LIMITS.storage_limit_bytes,
  grant_limit: FINITE_TEST_LIMITS.grant_limit,
  revision_limit: FINITE_TEST_LIMITS.revision_limit,
};

// ---------------------------------------------------------------------------
// checkStorage
// ---------------------------------------------------------------------------

describe("QuotaService.checkStorage", () => {
  it("allows exactly-at-limit upload", async () => {
    const limit = FINITE_TEST_LIMITS.storage_limit_bytes;
    const repo = makeRepo({ ...finiteLimits, bytes_used: limit - 100 });
    const quota = new QuotaService(repo, makeTokenRepo());
    const result = await quota.checkStorage("user1", 100, tx);
    expect(result.allowed).toBe(true);
  });

  it("allows when additionalBytes is 0 (overwrite same size)", async () => {
    const repo = makeRepo({
      ...finiteLimits,
      bytes_used: FINITE_TEST_LIMITS.storage_limit_bytes,
    });
    const quota = new QuotaService(repo, makeTokenRepo());
    const result = await quota.checkStorage("user1", 0, tx);
    expect(result.allowed).toBe(true);
  });

  it("allows negative additionalBytes (delete)", async () => {
    const repo = makeRepo({
      ...finiteLimits,
      bytes_used: FINITE_TEST_LIMITS.storage_limit_bytes,
    });
    const quota = new QuotaService(repo, makeTokenRepo());
    const result = await quota.checkStorage("user1", -500, tx);
    expect(result.allowed).toBe(true);
  });
});
