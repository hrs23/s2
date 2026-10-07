// POST /internal/trash/:id/restore — Restore a trash item (cookie-only)

import type { ActionFunctionArgs } from "react-router";
import { err, withAuth } from "~/lib/utils/http.server";

export function action(args: ActionFunctionArgs) {
  return withAuth(
    args,
    { method: "POST" },
    async ({ params, auth, services: { fileService } }) => {
      const nodeId = params.id;
      if (!nodeId) return err(400, "Node ID is required");
      const result = await fileService.restoreTrash(auth, nodeId);

      if (!result.ok) {
        switch (result.code) {
          case "not_found":
            return err(404, "Not Found");
          case "conflict":
            return err(
              409,
              "A file or folder with the same name already exists in the original location",
            );
          case "parent_in_trash":
            return err(
              409,
              "Parent folder is in trash. Restore the parent folder first.",
            );
        }
      }

      return Response.json({ ok: true });
    },
  );
}
