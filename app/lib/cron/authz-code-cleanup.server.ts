// Cron: delete expired OAuth authorization codes.
//
// PKCE codes are short-lived (typically 60s). Once `expires_at < now()` the
// row can never be exchanged, so retaining it only bloats the table and the
// `idx_oauth_authz_codes_expires` partial index.

import { createDbFromRuntimeEnv } from "~/lib/db/runtime.server";

export interface AuthzCodeCleanupResult {
  deleted: number;
}

export async function runAuthzCodeCleanup(
  env: Env,
): Promise<AuthzCodeCleanupResult> {
  const db = createDbFromRuntimeEnv(env);
  const result = await db.execute(
    `DELETE FROM oauth_authorization_codes WHERE expires_at < now()`,
  );
  return { deleted: result.rowCount };
}
