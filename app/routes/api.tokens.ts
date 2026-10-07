// POST /api/v1/tokens — create a token.
//   - Bearer with can_delegate => create a child token under the parent's scope
//   - cookie session            => create a token at the user root
// Listing user tokens lives at /internal/tokens (cookie-only).

import type { ActionFunctionArgs } from "react-router";
import { err, readJson, withAuth } from "~/lib/utils/http.server";

export function action(args: ActionFunctionArgs) {
  return withAuth(
    args,
    { method: "POST" },
    async ({ request, auth, services: { tokenService } }) => {
      const json = await readJson<{
        name?: unknown;
        base_path?: unknown;
        can_delegate?: unknown;
        expires_in_days?: unknown;
        access_paths?: unknown;
      }>(request);
      if (!json.ok) return json.response;
      const body = json.body;

      const result = await tokenService.create(auth, {
        name: body.name as string,
        base_path: body.base_path as string | undefined,
        can_delegate: body.can_delegate as boolean | undefined,
        expires_in_days: body.expires_in_days as number | undefined,
        access_paths: body.access_paths as Array<{
          path: string;
          access: "read" | "write";
        }>,
      });

      if (!result.ok) {
        switch (result.code) {
          case "limit_reached":
            return err(403, result.message);
          case "no_delegate_permission":
          case "scope_violation":
            return err(403, result.message);
          case "invalid_input":
            return err(400, result.message);
        }
      }

      return Response.json(
        {
          token: result.token,
          raw_token: result.raw_token,
          expires_at: result.expires_at,
        },
        { status: 201 },
      );
    },
  );
}
