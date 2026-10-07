// Cron: delete expired or revoked OAuth refresh tokens.
//
// Rows are pruned where `expires_at < now()` OR
// `revoked_at IS NOT NULL`. Both states make the row permanently unusable for
// token exchange, so the row has no security value left and only adds index
// pressure / blast radius if hashes ever leak.

import { createDbFromRuntimeEnv } from "~/lib/db/runtime.server";

export interface RefreshTokenCleanupResult {
  deleted: number;
}

export async function runRefreshTokenCleanup(
  env: Env,
): Promise<RefreshTokenCleanupResult> {
  const db = createDbFromRuntimeEnv(env);
  const result = await db.execute(
    `DELETE FROM refresh_tokens WHERE expires_at < now() OR revoked_at IS NOT NULL`,
  );
  return { deleted: result.rowCount };
}
