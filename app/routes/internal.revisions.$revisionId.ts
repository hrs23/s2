// DELETE /internal/revisions/:revisionId (cookie-only) — permanent
// delete of a non-current revision. Recovery / destructive operations are
// physically separated from the AI-reachable /api/v1/* surface.

import type { ActionFunctionArgs } from "react-router";
import { err, withAuth } from "~/lib/utils/http.server";

export function action(args: ActionFunctionArgs) {
  return withAuth(
    args,
    { method: "DELETE" },
    async ({ params, auth, services: { fileService } }) => {
      const revisionId = params.revisionId;
      if (!revisionId) return err(400, "Revision ID is required");
      const result = await fileService.deleteVersion(auth, revisionId);

      if (!result.ok) {
        switch (result.code) {
          case "forbidden":
            return err(403, "Forbidden");
          case "not_found":
            return err(404, "Not Found");
          case "is_current":
            return err(409, "Cannot delete the current revision");
        }
      }

      return new Response(null, { status: 204 });
    },
  );
}
