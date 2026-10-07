// DELETE /api/v1/tokens/:id — revoke a token.
//   - Bearer can revoke only child tokens it created
//   - cookie session can revoke any of the user's own tokens
// Metadata edits (PATCH) live at /internal/tokens/:id (cookie-only).

import type { ActionFunctionArgs } from "react-router";
import { err, withAuth } from "~/lib/utils/http.server";

export function action(args: ActionFunctionArgs) {
  return withAuth(
    args,
    { method: "DELETE" },
    async ({ params, auth, services: { tokenService } }) => {
      const tokenId = params.id;
      if (!tokenId) return err(400, "Invalid id");
      const result = await tokenService.delete(auth, tokenId);
      if (!result.ok) {
        switch (result.code) {
          case "not_found":
            return err(404, result.message);
          case "forbidden":
            return err(403, result.message);
          case "has_children":
            return err(409, result.message, "has_children");
        }
      }
      return new Response(null, { status: 204 });
    },
  );
}
