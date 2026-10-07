// Shared handler for /internal/tokens/:id/{issue,rotate} (cookie-only).
// cookie-only). Both endpoints differ only in which TokenService method
// they call: same auth check, same params parsing, same response shape,
// same error mapping. Centralizing avoids drift between the two routes.

import type { ActionFunctionArgs } from "react-router";
import { err, readJson, withAuth } from "~/lib/utils/http.server";

export type SecretLifecycleOp = "issue" | "rotate";

export function handleSecretLifecycle(
  args: ActionFunctionArgs,
  op: SecretLifecycleOp,
): Promise<Response> {
  return withAuth(
    args,
    { method: "POST" },
    async ({ request, params, auth, services: { tokenService } }) => {
      const tokenId = params.id;
      if (!tokenId) return err(400, "Invalid id");

      let body: { expires_in_days?: unknown } = {};
      if (
        (request.headers.get("Content-Type") ?? "").includes("application/json")
      ) {
        const json = await readJson<{ expires_in_days?: unknown }>(request);
        if (!json.ok) return json.response;
        body = json.body;
      }
      const expiresInDays =
        body.expires_in_days !== undefined
          ? Number(body.expires_in_days)
          : undefined;

      const result =
        op === "issue"
          ? await tokenService.issue(auth.user_id, tokenId, expiresInDays)
          : await tokenService.rotate(auth.user_id, tokenId, expiresInDays);

      if (!result.ok) {
        switch (result.code) {
          case "not_found":
            return err(404, result.message);
          case "conflict":
            return err(409, result.message);
          case "invalid_input":
            return err(400, result.message);
        }
      }

      return Response.json(
        { token: result.issued.token, expires_at: result.issued.expires_at },
        { status: 201 },
      );
    },
  );
}
