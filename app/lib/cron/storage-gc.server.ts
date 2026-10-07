// Cron: storage GC — the ONLY runtime path that deletes objects from blob storage.
// Every other delete path (trash purge, version pruning, account
// delete, over-quota enforcement, deleteVersion) must do DB-only work and
// rely on the file_revisions DELETE trigger to enqueue tombstones here.
//
// Why the indirection: we need DB ↔ object storage to stay consistent across
// database point-in-time restores. Holding the delete behind a
// `created_at + GC_GRACE_DAYS` cutoff means "rewinding the DB" automatically
// rewinds storage — chunks for any revision that comes back to life via restore
// are still on disk because we hadn't physically deleted them yet.
//
// Diagnostic mode: keep this worker the sole `.delete()` call site so the
// invariant "no other module touches storage delete" can be enforced by grep
// (see CONTRIBUTING.md).

import { createAppContext } from "~/lib/app-context.server";
import type { DbClient } from "~/lib/db/client.server";
import { createDbFromRuntimeEnv } from "~/lib/db/runtime.server";
import { logError, logInfo, logWarn } from "~/lib/observability/logger.server";
import type { StorageAdapter } from "~/lib/storage/adapter";

export interface StorageGcResult {
  scannedTombstones: number;
  /** Tombstones whose storage + DB delete fully succeeded. */
  deletedTombstones: number;
  /** Total chunk keys deleted from storage across all processed tombstones. */
  deletedChunks: number;
  /** Tombstones skipped because acquiring the advisory lock failed. */
  lockSkipped: boolean;
}

/** Postgres advisory-lock key. Distinct integer just for this cron. */
const ADVISORY_LOCK_KEY = 0x53324743; // "S2GC"

/** Each chunk key looks like `{storage_prefix}/c/{NNNNN}`. */
const CHUNK_KEY_RE = /\/c\/\d{5}$/;

/**
 * Enqueue a tombstone for a storage prefix. Used at the two non-trigger sites
 * (upload session cancel/cleanup, post-rollback chunk leaks) where a storage
 * PUT happened but no `file_revisions` row was created — so the DELETE
 * trigger can't fire. Idempotent: duplicate prefixes are harmless because
 * GC walks the prefix once and a second pass becomes a no-op.
 */
export async function enqueueStorageTombstone(
  db: DbClient,
  storagePrefix: string,
): Promise<void> {
  // gen_ulid() default on the column keeps the trigger and the explicit
  // path on the same ID format (see the 0064 migration).
  await db.execute(
    "INSERT INTO storage_tombstones (storage_prefix) VALUES ($1)",
    [storagePrefix],
  );
}

/**
 * Process tombstones whose grace window has elapsed.
 * Caller passes graceDays + batch size from cron-config.
 */
export async function runStorageGc(
  env: Env,
  graceDays: number,
  batchSize: number,
  storageOverride?: StorageAdapter,
): Promise<StorageGcResult> {
  const db = createDbFromRuntimeEnv(env);
  const storage: StorageAdapter =
    storageOverride ?? createAppContext(env).storage;

  // Single-writer guard. xact_lock auto-releases on commit/rollback so we
  // don't have to worry about pooled connections silently dropping the
  // session-scoped lock between statements. Concurrent runs
  // are harmless anyway (storage delete is idempotent, tombstone DELETE WHERE
  // id IN (...) is no-op for already-cleared rows) — the lock just
  // suppresses duplicate work / log noise.
  return await db.transaction(async (tx) => {
    const lockRow = await tx.queryOne<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1) AS ok",
      [ADVISORY_LOCK_KEY],
    );
    if (!lockRow?.ok) {
      logInfo("cron.storage_gc", "lock_skipped", {
        reason: "another worker holds the advisory lock",
      });
      return {
        scannedTombstones: 0,
        deletedTombstones: 0,
        deletedChunks: 0,
        lockSkipped: true,
      };
    }

    let scanned = 0;
    let chunkCount = 0;
    const completedIds: string[] = [];

    try {
      const rows = await tx.query<{ id: string; storage_prefix: string }>(
        `SELECT id, storage_prefix
         FROM storage_tombstones
         WHERE created_at < now() - ($1 || ' days')::interval
         ORDER BY created_at
         LIMIT $2`,
        [String(graceDays), batchSize],
      );

      for (const row of rows) {
        scanned++;

        // List then delete: a tombstone records the prefix only, not the
        // individual chunk keys. Defence in depth: filter to keys that
        // actually look like chunks so a bug elsewhere can't get amplified
        // into deleting unrelated objects sharing the prefix string.
        let perTombstoneDeleted = 0;
        try {
          const items = await storage.list(`${row.storage_prefix}/`);
          const keys = items
            .map((o) => o.key)
            .filter((k) => CHUNK_KEY_RE.test(k));
          // storage delete is idempotent (404 = success). Bulk form takes up to
          // 1000 keys per call.
          await storage.deleteMany(keys);
          perTombstoneDeleted = keys.length;
          completedIds.push(row.id);
          chunkCount += perTombstoneDeleted;
        } catch (e) {
          // Leave the tombstone row in place; next run retries. Per-tombstone
          // try/catch matches the existing best-effort patterns in
          // trash-purge / version-pruning so one storage hiccup never aborts the
          // whole batch.
          logWarn(
            "cron.storage_gc",
            "tombstone_delete_failed",
            {
              tombstoneId: row.id,
              storagePrefix: row.storage_prefix,
              partialChunkCount: perTombstoneDeleted,
            },
            e,
          );
        }
      }

      if (completedIds.length > 0) {
        // One bulk DB delete per run keeps round-trips low even for large
        // batches. Per-id failures already short-circuited via the catch
        // above, so this set is exactly the "storage cleanup succeeded" rows.
        await tx.execute(
          "DELETE FROM storage_tombstones WHERE id = ANY($1::text[])",
          [completedIds],
        );
      }
    } catch (e) {
      logError("cron.storage_gc", "batch_failed", {}, e);
      throw e;
    }

    return {
      scannedTombstones: scanned,
      deletedTombstones: completedIds.length,
      deletedChunks: chunkCount,
      lockSkipped: false,
    };
  });
}
