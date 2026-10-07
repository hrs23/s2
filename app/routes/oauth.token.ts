// POST /oauth/token — OAuth 2.1 Token endpoint
//
// Supports the Authorization Code and Refresh Token grants.
// Body is application/x-www-form-urlencoded (RFC 6749).

import type { ActionFunctionArgs } from "react-router";
import { getAppContext } from "~/lib/app-load-context.server";
import {
  jsonError,
  noCacheHeaders,
  oauthErrorResponse,
} from "~/lib/oauth/oauth-error-response";
import { createServices } from "~/lib/service-factory.server";

export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return jsonError(405, {
      error: "invalid_request",
      error_description: "method not allowed",
    });
  }

  const ct = request.headers.get("content-type") ?? "";
  if (!ct.includes("application/x-www-form-urlencoded")) {
    return jsonError(400, {
      error: "invalid_request",
      error_description:
        "content-type must be application/x-www-form-urlencoded",
    });
  }

  const form = await request.formData();
  const grantType = form.get("grant_type")?.toString();

  // Client authentication: HTTP Basic (preferred) or body fields
  const auth = parseClientAuth(request, form);

  // OAuth service operates without user context for /token (uses code/refresh).
  // userId is not known yet, so we use a placeholder for createServices.
  const { oauthService } = createServices(getAppContext(context), "");

  if (grantType === "authorization_code") {
    const code = form.get("code")?.toString() ?? "";
    const redirectUri = form.get("redirect_uri")?.toString() ?? "";
    const codeVerifier = form.get("code_verifier")?.toString() ?? "";
    if (!code || !redirectUri || !codeVerifier) {
      return jsonError(400, {
        error: "invalid_request",
        error_description: "code, redirect_uri, code_verifier are required",
      });
    }
    if (!auth.clientId) {
      return jsonError(400, {
        error: "invalid_client",
        error_description: "client_id is required",
      });
    }

    const result = await oauthService.exchangeCode({
      code,
      redirectUri,
      codeVerifier,
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
    });

    if (!result.ok) return oauthErrorResponse(result.error);
    return Response.json(result.value, {
      headers: noCacheHeaders(),
    });
  }

  if (grantType === "refresh_token") {
    const refreshToken = form.get("refresh_token")?.toString() ?? "";
    if (!refreshToken) {
      return jsonError(400, {
        error: "invalid_request",
        error_description: "refresh_token is required",
      });
    }
    if (!auth.clientId) {
      return jsonError(400, {
        error: "invalid_client",
        error_description: "client_id is required",
      });
    }

    const result = await oauthService.refreshAccessToken({
      refreshToken,
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
    });

    if (!result.ok) return oauthErrorResponse(result.error);
    return Response.json(result.value, {
      headers: noCacheHeaders(),
    });
  }

  return jsonError(400, {
    error: "unsupported_grant_type",
    error_description:
      "grant_type must be 'authorization_code' or 'refresh_token'",
  });
}

interface ClientAuth {
  clientId: string | undefined;
  clientSecret: string | undefined;
}

/**
 * Discovery advertises only `client_secret_basic`, so confidential clients send
 * credentials in the Authorization: Basic header. A client_secret in the body is
 * not accepted (per BCP). client_id is accepted in the body to identify public clients.
 */
function parseClientAuth(request: Request, form: FormData): ClientAuth {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Basic ")) {
    try {
      const decoded = atob(authHeader.slice("Basic ".length));
      const sep = decoded.indexOf(":");
      if (sep >= 0) {
        return {
          clientId: decodeURIComponent(decoded.slice(0, sep)),
          clientSecret: decodeURIComponent(decoded.slice(sep + 1)),
        };
      }
    } catch {
      // fall through
    }
  }
  return {
    clientId: form.get("client_id")?.toString() || undefined,
    // client_secret in the body is not accepted (advertised auth method = client_secret_basic only)
    clientSecret: undefined,
  };
}
