// PATCH /internal/tokens/:id (cookie-only) — update token metadata
// (name / base_path / can_delegate). Bearer is rejected at the middleware edge.

import type { ActionFunctionArgs } from "react-router";
import { err, readJson, withAuth } from "~/lib/utils/http.server";

export function action(args: ActionFunctionArgs) {
  return withAuth(
    args,
    { method: "PATCH" },
    async ({ request, params, auth, services: { tokenService } }) => {
      const tokenId = params.id;
      if (!tokenId) return err(400, "Invalid id");

      const json = await readJson<{
        name?: unknown;
        base_path?: unknown;
        can_delegate?: unknown;
      }>(request);
      if (!json.ok) return json.response;
      const body = json.body;
      const result = await tokenService.update(auth.user_id, tokenId, {
        name: body.name as string | undefined,
        base_path: body.base_path as string | undefined,
        can_delegate: body.can_delegate as boolean | undefined,
      });

      if (!result.ok) {
        switch (result.code) {
          case "not_found":
            return err(404, result.message);
          case "invalid_input":
            return err(400, result.message);
        }
      }

      return Response.json(result.token);
    },
  );
}
