// QuotaService: per-user quota for storage (bytes), access grants (count),
// and revision retention. Owns limit lookup so callers stay agnostic about
// where limits are stored.

import type { WithinUserTx, WithinUserWriteTx } from "~/lib/db/client.server";
import type { TokenRepository } from "./token-repository.server";
import type { QuotaInfo, UserRepository } from "./user-repository.server";

/** Default limits when no user_limits row exists (0 = unlimited). */
export const DEFAULT_USER_LIMITS = {
  storage_limit_bytes: 0,
  grant_limit: 0,
  revision_limit: 0,
} as const;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface StorageCheckResult {
  allowed: boolean;
  used: number;
  limit: number;
}

export interface UsageResult {
  used: number;
  limit: number;
  revision_limit: number;
}

export interface GrantUsageResult {
  count: number;
  limit: number;
}

// ---------------------------------------------------------------------------
// IQuotaService — external contract
// ---------------------------------------------------------------------------

/**
 * Public contract for per-user storage quota management (service layer).
 */
export interface IQuotaService {
  checkStorage(
    userId: string,
    additionalBytes: number,
    tx: WithinUserTx,
  ): Promise<StorageCheckResult>;
  updateBytesUsed(
    userId: string,
    delta: number,
    tx: WithinUserWriteTx,
  ): Promise<void>;
  setBytesUsed(
    userId: string,
    bytesUsed: number,
    tx: WithinUserWriteTx,
  ): Promise<void>;
  getUsage(userId: string, tx: WithinUserTx): Promise<UsageResult>;
  getGrantUsage(userId: string, tx: WithinUserTx): Promise<GrantUsageResult>;
}

// ---------------------------------------------------------------------------
// QuotaService
// ---------------------------------------------------------------------------

function resolveLimits(info: QuotaInfo | null): {
  storage_limit_bytes: number;
  grant_limit: number;
  revision_limit: number;
} {
  if (!info) return DEFAULT_USER_LIMITS;
  return {
    storage_limit_bytes: info.storage_limit_bytes,
    grant_limit: info.grant_limit,
    revision_limit: info.revision_limit,
  };
}

export class QuotaService implements IQuotaService {
  constructor(
    private userRepo: UserRepository,
    private tokenRepo: TokenRepository,
  ) {}

  /**
   * Check if adding additionalBytes would exceed the user's storage limit.
   */
  async checkStorage(
    userId: string,
    additionalBytes: number,
    tx: WithinUserTx,
  ): Promise<StorageCheckResult> {
    const info = await this.userRepo.getQuotaInfo(userId, tx);
    const limits = resolveLimits(info);
    const used = Number(info?.bytes_used ?? 0);
    const limit = limits.storage_limit_bytes;
    const allowed =
      limit === 0 || additionalBytes <= 0 || used + additionalBytes <= limit;
    return { allowed, used, limit };
  }

  /**
   * Update bytes_used by delta (positive = increase, negative = decrease).
   * Usage limits are checked before writes; this only updates the counter.
   */
  async updateBytesUsed(
    userId: string,
    delta: number,
    tx: WithinUserWriteTx,
  ): Promise<void> {
    if (delta === 0) return;
    await this.userRepo.addBytesUsed(delta, userId, tx);
  }

  /**
   * Set bytes_used to an absolute value.
   * Replaces the usage counter with an absolute value.
   */
  async setBytesUsed(
    userId: string,
    bytesUsed: number,
    tx: WithinUserWriteTx,
  ): Promise<void> {
    await this.userRepo.setBytesUsed(bytesUsed, userId, tx);
  }

  /**
   * Get combined usage info for a user.
   */
  async getUsage(userId: string, tx: WithinUserTx): Promise<UsageResult> {
    const info = await this.userRepo.getQuotaInfo(userId, tx);
    const limits = resolveLimits(info);
    const used = Number(info?.bytes_used ?? 0);
    return {
      used,
      limit: limits.storage_limit_bytes,
      revision_limit: limits.revision_limit,
    };
  }

  /**
   * Access grant pool usage (manual + delegated + OAuth share one pool).
   */
  async getGrantUsage(
    userId: string,
    tx: WithinUserTx,
  ): Promise<GrantUsageResult> {
    const [info, count] = await Promise.all([
      this.userRepo.getQuotaInfo(userId, tx),
      this.tokenRepo.countByUser(userId, tx),
    ]);
    const limits = resolveLimits(info);
    return { count, limit: limits.grant_limit };
  }
}
