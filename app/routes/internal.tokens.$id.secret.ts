// DELETE /internal/tokens/:id/secret — Revoke the token's active secret
// (cookie-only). Clears hash + expires_at; the token row itself
// is retained so that access_paths and name stay editable before a re-issue.

import type { ActionFunctionArgs } from "react-router";
import { err, withAuth } from "~/lib/utils/http.server";

export function action(args: ActionFunctionArgs) {
  return withAuth(
    args,
    {},
    async ({ request, params, auth, services: { tokenService } }) => {
      const tokenId = params.id;
      if (!tokenId) return err(400, "Invalid id");

      if (request.method !== "DELETE") return err(405, "Method Not Allowed");

      const result = await tokenService.revoke(auth.user_id, tokenId);
      if (!result.ok) {
        return err(404, result.message);
      }
      return new Response(null, { status: 204 });
    },
  );
}
