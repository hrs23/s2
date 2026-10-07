// GET /internal/oauth-grants — List OAuth-authorized apps for the user
// (cookie-only).

import type { LoaderFunctionArgs } from "react-router";
import { withAuth } from "~/lib/utils/http.server";

export type { OAuthGrantSummary } from "~/lib/oauth/oauth-service.server";

export function loader(args: LoaderFunctionArgs) {
  return withAuth(args, {}, async ({ auth, services: { oauthService } }) => {
    const grants = await oauthService.listGrantsForUser(auth.user_id);
    return Response.json({ grants });
  });
}
