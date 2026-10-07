// POST /api/v1/uploads/:id/complete — Commit an upload session to the file tree.
// Verifies chunks, does CAS update on file_nodes, marks session completed.

import type { ActionFunctionArgs } from "react-router";
import { err, withAuth } from "~/lib/utils/http.server";

export function action(args: ActionFunctionArgs) {
  return withAuth(
    args,
    { method: "POST" },
    async ({ params, auth, services: { uploadService } }) => {
      const sessionId = params.id;
      if (!sessionId) return err(400, "Session ID required");
      const result = await uploadService.completeSession(auth, sessionId);

      if (!result.ok) {
        const statusMap = {
          bad_request: 400,
          not_found: 404,
          conflict: 409,
          expired: 410,
          quota_exceeded: 413,
        } as const;
        return err(statusMap[result.code], result.message);
      }

      return Response.json({
        nodeId: result.nodeId,
        size: result.size,
        chunkCount: result.chunkCount,
        content_version: result.contentVersion,
      });
    },
  );
}
