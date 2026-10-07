// POST /api/v1/uploads — Create upload session for large file (>100MB) uploads.

import type { ActionFunctionArgs } from "react-router";
import { stripLeadingSlashes } from "~/lib/files/paths";
import { err, readJson, withAuth } from "~/lib/utils/http.server";

export function action(args: ActionFunctionArgs) {
  return withAuth(
    args,
    { method: "POST" },
    async ({ request, auth, services: { uploadService } }) => {
      const json = await readJson<{ path: string; totalSize: number }>(request);
      if (!json.ok) return json.response;
      const body = json.body;

      if (!body.path || typeof body.path !== "string") {
        return err(400, "path is required");
      }

      // Reject directory paths (root "/" or trailing slash) — uploads must target a file
      const cleanPath = stripLeadingSlashes(body.path);
      if (!cleanPath || cleanPath.endsWith("/"))
        return err(400, "path must point to a file, not a directory");
      const result = await uploadService.createSession(auth, {
        rawPath: body.path,
        totalSize: body.totalSize,
      });

      if (!result.ok) {
        const statusMap = {
          bad_request: 400,
          forbidden: 403,
          quota_exceeded: 413,
        } as const;
        return err(statusMap[result.code], result.message);
      }

      return Response.json(
        {
          sessionId: result.sessionId,
          nodeId: result.nodeId,
          chunkSize: result.chunkSize,
          expiresAt: result.expiresAt,
        },
        { status: 201 },
      );
    },
  );
}
