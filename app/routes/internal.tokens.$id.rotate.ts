// POST /internal/tokens/:id/rotate — Replace the token's active secret
// (cookie-only). 409 if no secret has ever been issued; use /issue.

import type { ActionFunctionArgs } from "react-router";
import { handleSecretLifecycle } from "~/lib/auth/token-secret-handler.server";

export const action = (args: ActionFunctionArgs) =>
  handleSecretLifecycle(args, "rotate");
