// Cron: purge expired trash nodes.
// DB delete + bytes_used decrement run in one transaction.
//
// Under the app role (NOBYPASSRLS) the user-owned tables only return
// rows when `app.user_id` is set. We fan out per user via withUserTx so each
// user's purge runs in its own RLS-scoped transaction. Failures of one user
// do not abort the whole sweep.

import { QuotaService } from "~/lib/auth/quota-service.server";
import { TokenRepository } from "~/lib/auth/token-repository.server";
import { UserRepository } from "~/lib/auth/user-repository.server";
import { createDbFromRuntimeEnv } from "~/lib/db/runtime.server";
import { TrashRepository } from "~/lib/files/trash-repository.server";
import { logError, logInfo } from "~/lib/observability/logger.server";

export interface TrashPurgeResult {
  usersScanned: number;
  usersFailed: number;
  purgedNodes: number;
}

/**
 * Purge expired trash nodes (deleted_at older than retentionDays).
 * Hard-deletes file_nodes (CASCADE → file_revisions) and decrements
 * bytes_used. Aggregate counts are emitted via the structured logger.
 */
export async function runTrashPurge(
  env: Env,
  retentionDays: number,
): Promise<TrashPurgeResult> {
  const db = createDbFromRuntimeEnv(env);
  const userRepo = new UserRepository(db);
  const repo = new TrashRepository();
  const maxAge = retentionDays * 24 * 60 * 60 * 1000;
  const quota = new QuotaService(userRepo, new TokenRepository(db));

  const userIds = await userRepo.listAllUserIds();

  let purgedNodes = 0;
  let usersFailed = 0;

  for (const userId of userIds) {
    const startedAt = Date.now();
    try {
      const purged = await db.withUserWriteTx(userId, async (tx) => {
        const result = await repo.purgeExpiredTrash(userId, maxAge, tx);
        if (result.totalSize > 0) {
          await quota.updateBytesUsed(userId, -result.totalSize, tx);
        }
        // Lifecycle is emitted below via logInfo.
        return result;
      });

      if (purged.nodes.length > 0) {
        logInfo("cron.trash_purge", "purged", {
          userId,
          count: purged.nodes.length,
          bytesFreed: purged.totalSize,
          durationMs: Date.now() - startedAt,
        });
      }

      purgedNodes += purged.nodes.length;
    } catch (err) {
      usersFailed++;
      logError("cron.trash_purge", "user_failed", { userId }, err);
    }
  }

  return {
    usersScanned: userIds.length,
    usersFailed,
    purgedNodes,
  };
}
