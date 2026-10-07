// edge middleware decisions, in pure (Request → Response | null)
// form so the server entrypoint and the unit test exercise the SAME code.
//
//   - /internal/*  cookie-only WebUI surface. Reject Authorization headers
//                  at the edge so a leaked Bearer cannot reach account /
//                  account / recovery endpoints (defence-in-depth; the auth
//                  resolver itself is header-based and Bearer-blind to URL
//                  prefix).
//   - CSRF guard   cookie-authed unsafe methods (any URL prefix) must come
//                  from the app's origin. Bearer-authed requests are exempt
//                  (no auto-attached cookie). Better Auth (/api/auth/*)
//                  enforces its own Origin check.
//
// Keeping these predicates pure (no env / fetch / DB) means the test can
// drive them with synthetic Requests instead of re-implementing the logic.

import { checkSameOrigin } from "~/lib/auth/origin-check.server";
import { isInternal } from "~/lib/auth/prefixes.server";
import { BETTER_AUTH_SESSION_COOKIE } from "~/lib/auth.server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Built once at module scope to avoid per-request RegExp construction.
const SESSION_COOKIE_RE = new RegExp(
  `(?:^|;\\s*)(?:__Secure-)?${BETTER_AUTH_SESSION_COOKIE.replace(".", "\\.")}=`,
);

function hasAuthorization(request: Request): boolean {
  return !!request.headers.get("Authorization");
}

// The Better Auth session cookie is the only cookie that authenticates a
// user. Other cookies (locale, two_factor pending, …) are not auth-bearing.
function hasSessionCookie(request: Request): boolean {
  return SESSION_COOKIE_RE.test(request.headers.get("Cookie") ?? "");
}

function forbidden(message: string): Response {
  return Response.json(
    { error: { code: "forbidden", message } },
    { status: 403 },
  );
}

/**
 * Returns a 403 Response if the request should be blocked at the edge,
 * `null` otherwise. `appUrl` is the configured app origin (env.APP_URL);
 * pass `""` (or anything `new URL()` rejects) to fail closed on CSRF.
 */
export function evaluateEdge(
  request: Request,
  pathname: string,
  appUrl: string,
): Response | null {
  // /internal/* — Bearer rejected at the edge.
  if (isInternal(pathname) && hasAuthorization(request)) {
    return forbidden("Bearer not accepted on /internal/*");
  }

  // CSRF: cookie-authed unsafe methods must originate from APP_URL.
  // SameSite=Lax keeps the cookie off most cross-origin POSTs, but a
  // top-level form submission fallback is still possible — verify Origin
  // to close it. Bearer-authed requests have no auto-attached cookie, so
  // they're exempt. /api/auth/* runs Better Auth's built-in Origin check.
  if (
    !SAFE_METHODS.has(request.method) &&
    hasSessionCookie(request) &&
    !pathname.startsWith("/api/auth/")
  ) {
    const result = checkSameOrigin(request, appUrl);
    if (!result.ok) return forbidden("Cross-origin request blocked");
  }

  return null;
}
