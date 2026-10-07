// Cron: prune excess file_revisions beyond the configured version limit.
// bytes_used is decremented atomically with the prune.
//
// Fan out per user via withUserTx (NOBYPASSRLS app role).

import { QuotaService } from "~/lib/auth/quota-service.server";
import { TokenRepository } from "~/lib/auth/token-repository.server";
import { UserRepository } from "~/lib/auth/user-repository.server";
import { createDbFromRuntimeEnv } from "~/lib/db/runtime.server";
import { VersionRepository } from "~/lib/files/version-repository.server";
import { logError, logInfo } from "~/lib/observability/logger.server";

export interface VersionPruningResult {
  usersScanned: number;
  usersFailed: number;
  prunedRevisions: number;
}

/**
 * Delete file_revisions beyond maxPastVersions per file, scoped per user.
 * Skipped when maxPastVersions <= 0 (disabled).
 */
export async function runVersionPruning(
  env: Env,
  /** Number of past revisions to keep per file. 0 = disabled. */
  maxPastVersions: number,
): Promise<VersionPruningResult> {
  if (maxPastVersions <= 0) {
    return { usersScanned: 0, usersFailed: 0, prunedRevisions: 0 };
  }

  const db = createDbFromRuntimeEnv(env);
  const userRepo = new UserRepository(db);
  const repo = new VersionRepository();
  const quota = new QuotaService(userRepo, new TokenRepository(db));

  const userIds = await userRepo.listAllUserIds();

  let prunedRevisions = 0;
  let usersFailed = 0;

  for (const userId of userIds) {
    const startedAt = Date.now();
    try {
      const pruned = await db.withUserWriteTx(userId, async (tx) => {
        const result = await repo.pruneExcessRevisions(
          userId,
          maxPastVersions,
          tx,
        );

        const totalSize = result.reduce((s, r) => s + r.size, 0);
        if (totalSize > 0) {
          await quota.updateBytesUsed(userId, -totalSize, tx);
        }

        // Lifecycle is observed via the structured log below.
        // `path_after` is intentionally not logged (PII).
        return result;
      });

      if (pruned.length > 0) {
        logInfo("cron.version_pruning", "pruned", {
          userId,
          count: pruned.length,
          bytesFreed: pruned.reduce((s, r) => s + r.size, 0),
          durationMs: Date.now() - startedAt,
        });
      }

      prunedRevisions += pruned.length;
    } catch (err) {
      usersFailed++;
      logError("cron.version_pruning", "user_failed", { userId }, err);
    }
  }

  return {
    usersScanned: userIds.length,
    usersFailed,
    prunedRevisions,
  };
}
