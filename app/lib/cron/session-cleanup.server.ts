// Cron: clean up expired upload sessions.
// Session chunks were never written to file_revisions, so the DELETE
// trigger can't enqueue a tombstone for them — enqueue manually.
//
// upload_sessions is RLS-protected so this cron also fans out
// per user via withUserTx, same pattern as trash-purge / version-pruning.

import { UserRepository } from "~/lib/auth/user-repository.server";
import { enqueueStorageTombstone } from "~/lib/cron/storage-gc.server";
import { createDbFromRuntimeEnv } from "~/lib/db/runtime.server";
import { UploadSessionRepository } from "~/lib/files/upload-session-repository.server";
import { logError } from "~/lib/observability/logger.server";
import { sessionStoragePrefix } from "~/lib/storage/chunked.server";

export interface SessionCleanupResult {
  usersScanned: number;
  usersFailed: number;
  expired: number;
  deleted: number;
}

export async function runSessionCleanup(
  env: Env,
): Promise<SessionCleanupResult> {
  const db = createDbFromRuntimeEnv(env);
  const userRepo = new UserRepository(db);
  const repo = new UploadSessionRepository();

  const userIds = await userRepo.listAllUserIds();

  let expired = 0;
  let deleted = 0;
  let usersFailed = 0;

  for (const userId of userIds) {
    try {
      const userResult = await db.withUserWriteTx(userId, async (tx) => {
        const sessions = await repo.findExpired(userId, tx);
        let userDeleted = 0;
        for (const session of sessions) {
          const prefix = sessionStoragePrefix(
            session.userId,
            session.nodeId,
            session.id,
          );
          // Enqueue first, then delete. Order matters for crash safety: if
          // the enqueue commits but the delete crashes, the next run sees
          // the same session and re-enqueues — that's a duplicate tombstone,
          // which GC handles as a no-op on the second pass. Reverse order
          // would orphan storage chunks if the enqueue fails after the session
          // row is gone.
          await enqueueStorageTombstone(tx, prefix);
          await repo.delete(session.id, tx);
          userDeleted++;
        }
        return { expired: sessions.length, deleted: userDeleted };
      });
      expired += userResult.expired;
      deleted += userResult.deleted;
    } catch (err) {
      usersFailed++;
      logError("cron.session_cleanup", "user_failed", { userId }, err);
    }
  }

  return {
    usersScanned: userIds.length,
    usersFailed,
    expired,
    deleted,
  };
}
