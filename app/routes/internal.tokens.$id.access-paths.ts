// PUT /internal/tokens/:id/access-paths — Replace all access paths (cookie-only)

import type { ActionFunctionArgs } from "react-router";
import { err, readJson, withAuth } from "~/lib/utils/http.server";

export function action(args: ActionFunctionArgs) {
  return withAuth(
    args,
    { method: "PUT" },
    async ({ request, params, auth, services: { tokenService } }) => {
      const tokenId = params.id;
      if (!tokenId) return err(400, "Invalid id");

      const json = await readJson<{ access_paths?: unknown }>(request);
      if (!json.ok) return json.response;
      const body = json.body;

      const result = await tokenService.replaceAccessPaths(
        auth.user_id,
        tokenId,
        body.access_paths as Array<{
          path: string;
          access: "read" | "write";
        }>,
      );

      if (!result.ok) {
        switch (result.code) {
          case "not_found":
            return err(404, result.message);
          case "invalid_input":
            return err(400, result.message);
        }
      }

      return Response.json({ access_paths: result.access_paths });
    },
  );
}
