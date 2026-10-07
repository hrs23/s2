// GET /internal/account — Return user profile and usage (cookie-only).
// The middleware rejects Bearer at the edge so this handler can
// trust that getAuthContext returns a user context.

import type { LoaderFunctionArgs } from "react-router";
import {
  isPasskeyEnabled,
  isTotpEnabled,
} from "~/lib/auth/auth-feature-policy";
import { err, withAuth } from "~/lib/utils/http.server";

export function loader(args: LoaderFunctionArgs) {
  return withAuth(
    args,
    {},
    async ({ env, auth, services: { db, userRepo } }) => {
      // user_limits / user_storage are RLS-protected.
      const user = await db.withUserTx(auth.user_id, (tx) =>
        userRepo.getById(auth.user_id, tx),
      );
      if (!user) return err(404, "User not found");
      return Response.json({
        type: "user",
        user_id: auth.user_id,
        email: user.email,
        storage_limit_bytes: user.storage_limit_bytes,
        grant_limit: user.grant_limit,
        revision_limit: user.revision_limit,
        two_factor_enabled: user.two_factor_enabled,
        passkey_enabled: isPasskeyEnabled(env),
        totp_enabled: isTotpEnabled(env),
      });
    },
  );
}
