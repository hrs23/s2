// POST /internal/tokens/:id/issue — First-time secret issuance (cookie-only).
// 409 if the token already has an active secret; use /rotate instead.

import type { ActionFunctionArgs } from "react-router";
import { handleSecretLifecycle } from "~/lib/auth/token-secret-handler.server";

export const action = (args: ActionFunctionArgs) =>
  handleSecretLifecycle(args, "issue");
