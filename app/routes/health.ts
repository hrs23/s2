// GET /health — Health check endpoint
// Checks DB and object-storage connectivity.
// Response format follows IETF Health Check Response Format (draft-inadarei-api-health-check).

import type { LoaderFunctionArgs } from "react-router";
import { getAppContext } from "~/lib/app-load-context.server";

type CheckStatus = "pass" | "fail";

export async function loader({ context }: LoaderFunctionArgs) {
  const appContext = getAppContext(context);
  const checks: Record<string, { status: CheckStatus }> = {};

  // DB check
  try {
    await appContext.db.ping();
    checks.db = { status: "pass" };
  } catch {
    checks.db = { status: "fail" };
  }

  // Storage check
  try {
    await appContext.storage.head("__health__");
    checks.storage = { status: "pass" };
  } catch {
    // head() on non-existent key returns null, not throw.
    // If it throws, it's a connection error.
    checks.storage = { status: "fail" };
  }

  const healthy = Object.values(checks).every((c) => c.status === "pass");

  return Response.json(
    { status: healthy ? "pass" : "fail", checks },
    {
      status: healthy ? 200 : 503,
      headers: { "Content-Type": "application/health+json" },
    },
  );
}
