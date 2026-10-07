import { runAuthzCodeCleanup } from "~/lib/cron/authz-code-cleanup.server";
import { readCronConfig } from "~/lib/cron/cron-config.server";
import { runDcrCleanup } from "~/lib/cron/dcr-cleanup.server";
import { runRefreshTokenCleanup } from "~/lib/cron/refresh-token-cleanup.server";
import { runSessionCleanup } from "~/lib/cron/session-cleanup.server";
import { runStorageGc } from "~/lib/cron/storage-gc.server";
import { runTrashPurge } from "~/lib/cron/trash-purge.server";
import { runVersionPruning } from "~/lib/cron/version-pruning.server";
import { logError, logInfo, logWarn } from "~/lib/observability/logger.server";
import { summarizeAllSettled } from "~/lib/observability/settled";

/** Daily maintenance cron schedule (17:00 UTC / 02:00 JST). */
export const DAILY_CRON = "0 17 * * *";

/**
 * Run all daily maintenance jobs. Wired by `startMaintenanceScheduler` on the
 * Node self-host server.
 */
export async function runDailyMaintenance(env: Env): Promise<void> {
  const config = readCronConfig(env);
  const jobs = [
    "trash_purge",
    "version_pruning",
    "session_cleanup",
    "storage_gc",
    "dcr_cleanup",
    "authz_code_cleanup",
    "refresh_token_cleanup",
  ] as const;
  const results = await Promise.allSettled([
    runTrashPurge(env, config.trashRetentionDays),
    runVersionPruning(env, config.maxPastVersions),
    runSessionCleanup(env),
    runStorageGc(env, config.gcGraceDays, config.gcBatchSize),
    runDcrCleanup(env),
    runAuthzCodeCleanup(env),
    runRefreshTokenCleanup(env),
  ]);

  const jobResults = summarizeAllSettled(jobs, results);
  for (const [i, r] of results.entries()) {
    if (r.status === "rejected") {
      logError("cron", `${jobs[i]}_failed`, {}, r.reason);
    }
  }
  const allOk = results.every((r) => r.status === "fulfilled");
  if (allOk) {
    logInfo("cron", "completed", { jobs: jobResults });
  } else {
    logWarn("cron", "completed_with_failures", { jobs: jobResults });
  }
}
