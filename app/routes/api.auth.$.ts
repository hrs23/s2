// Better Auth catch-all route.
//
// Mounts the Better Auth handler at /api/auth/*. See app/lib/auth.server.ts.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getRuntimeEnv } from "~/lib/app-load-context.server";
import { createAuth } from "~/lib/auth.server";
import { logInfo } from "~/lib/observability/logger.server";

async function handle({
  request,
  context,
}: LoaderFunctionArgs | ActionFunctionArgs) {
  const env = getRuntimeEnv(context);
  const url = new URL(request.url);
  const t0 = Date.now();
  let status: number | undefined;
  try {
    const res = await createAuth(env as Env).handler(request);
    status = res.status;
    return res;
  } finally {
    logInfo("auth.handler", "completed", {
      path: url.pathname,
      method: request.method,
      status,
      durationMs: Date.now() - t0,
    });
  }
}

export const loader = handle;
export const action = handle;
