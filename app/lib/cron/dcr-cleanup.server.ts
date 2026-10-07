// Cron: hard-delete unused DCR clients.
// Called by runDailyMaintenance() on the Node self-host scheduler.
//
// "Unused" = a DCR client that never had a grant attached (no oauth_grants row).
// Deleted physically once 30 days have passed; this naturally sweeps registration spam.
// There is no soft-delete (deleted_at): a client either exists or is gone.

import { createDbFromRuntimeEnv } from "~/lib/db/runtime.server";
import { OAuthClientRepository } from "~/lib/oauth/oauth-client-repository.server";

export interface DcrCleanupResult {
  deleted: number;
}

const DEFAULT_OLDER_THAN_DAYS = 30;

export async function runDcrCleanup(
  env: Env,
  olderThanDays: number = DEFAULT_OLDER_THAN_DAYS,
): Promise<DcrCleanupResult> {
  const db = createDbFromRuntimeEnv(env);
  const repo = new OAuthClientRepository(db);
  const deleted = await repo.cleanupUnusedDcrClients(olderThanDays);
  return { deleted };
}
