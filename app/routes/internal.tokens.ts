// GET /internal/tokens (cookie-only) — list the authenticated
// user's tokens. Bearer is rejected at the middleware edge.

import type { LoaderFunctionArgs } from "react-router";
import { withAuth } from "~/lib/utils/http.server";

export function loader(args: LoaderFunctionArgs) {
  return withAuth(args, {}, async ({ auth, services: { tokenService } }) => {
    const result = await tokenService.list(auth.user_id);
    return Response.json(result);
  });
}
