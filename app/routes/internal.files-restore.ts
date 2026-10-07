// POST /internal/files-restore (cookie-only) — restore a previous
// revision of a file. Recovery operations are physically separated from the
// AI-reachable /api/v1/* surface.
// Body: { path: "some/file", revision_id: "..." }

import type { ActionFunctionArgs } from "react-router";
import { isNonEmptyPath } from "~/lib/files/paths";
import {
  err,
  mapFileOpError,
  readJson,
  withAuth,
} from "~/lib/utils/http.server";

export function action(args: ActionFunctionArgs) {
  return withAuth(
    args,
    { method: "POST" },
    async ({ request, auth, services: { fileService } }) => {
      const json = await readJson<{ path?: unknown; revision_id?: unknown }>(
        request,
      );
      if (!json.ok) return json.response;
      const body = json.body;
      if (!isNonEmptyPath(body.path)) return err(400, "path is required");
      if (typeof body.revision_id !== "string" || !body.revision_id)
        return err(400, "revision_id is required");
      const result = await fileService.restoreRevision(
        auth,
        body.path,
        body.revision_id,
      );

      if (!result.ok) {
        return mapFileOpError(result.code, {
          conflict: "File was modified concurrently. Refresh and try again.",
        });
      }

      return Response.json({ ok: true });
    },
  );
}
