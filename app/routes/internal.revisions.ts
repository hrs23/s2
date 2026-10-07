// GET /internal/revisions?path=... (cookie-only) — list revisions
// for a path. Bearer is rejected at the middleware edge; the API surface for
// agents is intentionally limited to current-content reads + the immutable
// snapshot pair (/api/v1/revisions/:id), not version history.

import type { LoaderFunctionArgs } from "react-router";
import { isNonEmptyPath } from "~/lib/files/paths";
import { err, mapFileOpError, withAuth } from "~/lib/utils/http.server";

export function loader(args: LoaderFunctionArgs) {
  return withAuth(
    args,
    {},
    async ({ request, auth, services: { fileService } }) => {
      const url = new URL(request.url);
      const rawPath = url.searchParams.get("path") ?? "";
      if (!isNonEmptyPath(rawPath)) return err(400, "path is required");
      const result = await fileService.listRevisions(auth, rawPath);

      if (!result.ok) {
        if (result.code === "invalid_path") return err(400, "Invalid path");
        return mapFileOpError(result.code);
      }

      return Response.json({
        revisions: result.revisions.map((r) => ({
          id: r.id,
          size: r.size,
          content_type: r.contentType,
          hash: r.hash,
          created_at: r.createdAt,
          is_current: r.isCurrent,
        })),
      });
    },
  );
}
