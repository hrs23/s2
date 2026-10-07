// GET /api/v1/token — token introspection (Bearer-only).
// Returns the token's user_id, token_id, can_delegate flag, and access_paths
// (relative to the token's base_path). Cookie sessions get 403 — they have
// /internal/account for the equivalent user-side context.
//
// Token holders cannot learn the absolute position of their base_path within
// the delegator's tree.

import type { LoaderFunctionArgs } from "react-router";
import type { TokenIntrospection } from "~/lib/api";
import { err, withAuth } from "~/lib/utils/http.server";

export function loader(args: LoaderFunctionArgs) {
  return withAuth(args, {}, async ({ auth }) => {
    if (auth.type !== "token") {
      return err(403, "Bearer token required");
    }

    return Response.json({
      user_id: auth.user_id,
      token_id: auth.token_id,
      can_delegate: auth.can_delegate,
      access_paths: auth.access_paths,
    } satisfies TokenIntrospection);
  });
}
