// DELETE /api/v1/uploads/:id — Cancel and clean up an upload session.

import type { ActionFunctionArgs } from "react-router";
import { err, withAuth } from "~/lib/utils/http.server";

export function action(args: ActionFunctionArgs) {
  return withAuth(
    args,
    { method: "DELETE" },
    async ({ params, auth, services: { uploadService } }) => {
      const sessionId = params.id;
      if (!sessionId) return err(400, "Session ID required");
      const result = await uploadService.cancelSession(auth, sessionId);

      if (!result.ok) {
        const statusMap = {
          not_found: 404,
          conflict: 409,
        } as const;
        return err(statusMap[result.code], result.message);
      }

      return new Response(null, { status: 204 });
    },
  );
}
