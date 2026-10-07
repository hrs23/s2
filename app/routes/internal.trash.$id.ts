// DELETE /internal/trash/:id — Permanently delete a single trash item (cookie-only)

import type { ActionFunctionArgs } from "react-router";
import { err, withAuth } from "~/lib/utils/http.server";

export function action(args: ActionFunctionArgs) {
  return withAuth(
    args,
    { method: "DELETE" },
    async ({ params, auth, services: { fileService } }) => {
      const nodeId = params.id;
      if (!nodeId) return err(400, "Node ID is required");
      const result = await fileService.purgeTrashItem(auth, nodeId);

      if (!result.ok) {
        return err(404, "Not Found");
      }

      return new Response(null, { status: 204 });
    },
  );
}
