// Shared OAuth error response builders for /oauth/token and /oauth/register.

import type { OAuthError } from "./types";

/** Token / registration responses must never be cached (RFC 6749 §5.1). */
export function noCacheHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  };
}

/** Map an OAuth error code to an HTTP status (RFC 6749 §5.2 / RFC 7591 §3.2.2). */
function httpStatusForOAuthError(code: OAuthError["error"]): number {
  switch (code) {
    case "invalid_client":
      return 401;
    case "too_many_requests":
      return 429;
    case "server_error":
      return 500;
    default:
      return 400;
  }
}

/** JSON OAuth error body with an explicit status. */
export function jsonError(status: number, err: OAuthError): Response {
  return Response.json(err, { status, headers: noCacheHeaders() });
}

/** JSON OAuth error body with the status derived from the error code. */
export function oauthErrorResponse(err: OAuthError): Response {
  return jsonError(httpStatusForOAuthError(err.error), err);
}
