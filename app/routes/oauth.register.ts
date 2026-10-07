// POST /oauth/register — Dynamic Client Registration (RFC 7591)
//
// Unauthenticated public endpoint. Every OAuth client registers through DCR
// (flat DCR: no first-party / third-party distinction).
//
// Abuse protection (in-code):
//   - client_name validation (length / charset / reserved words)
//   - redirect_uri allowlist (loopback http or https only)
//   - registration quota (global trailing-window count)

import type { ActionFunctionArgs } from "react-router";
import { getAppContext } from "~/lib/app-load-context.server";
import {
  jsonError,
  noCacheHeaders,
  oauthErrorResponse,
} from "~/lib/oauth/oauth-error-response";
import type { TokenEndpointAuthMethod } from "~/lib/oauth/types";
import { createServices } from "~/lib/service-factory.server";

interface RegisterBody {
  client_name?: unknown;
  redirect_uris?: unknown;
  token_endpoint_auth_method?: unknown;
  // RFC 7591 also defines logo_uri / client_uri / contacts etc.; we store them in metadata
  [key: string]: unknown;
}

export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return jsonError(405, {
      error: "invalid_request",
      error_description: "method not allowed",
    });
  }

  const ct = request.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    return jsonError(400, {
      error: "invalid_request",
      error_description: "content-type must be application/json",
    });
  }

  let body: RegisterBody;
  try {
    body = (await request.json()) as RegisterBody;
  } catch {
    return jsonError(400, {
      error: "invalid_request",
      error_description: "invalid JSON body",
    });
  }

  const clientName =
    typeof body.client_name === "string" ? body.client_name : "";
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === "string")
    : [];
  const authMethodRaw =
    typeof body.token_endpoint_auth_method === "string"
      ? body.token_endpoint_auth_method
      : "none";
  if (authMethodRaw !== "none" && authMethodRaw !== "client_secret_basic") {
    return jsonError(400, {
      error: "invalid_client_metadata",
      error_description:
        "token_endpoint_auth_method must be 'none' or 'client_secret_basic'",
    });
  }
  const authMethod = authMethodRaw as TokenEndpointAuthMethod;

  // Optional metadata: client_uri / logo_uri / contacts / policy_uri / tos_uri
  const allowedMetadataKeys = [
    "client_uri",
    "logo_uri",
    "contacts",
    "policy_uri",
    "tos_uri",
    "software_id",
    "software_version",
  ] as const;
  const metadata: Record<string, unknown> = {};
  for (const key of allowedMetadataKeys) {
    if (key in body) metadata[key] = body[key];
  }

  const { oauthService } = createServices(getAppContext(context), "");
  const result = await oauthService.registerDcrClient({
    clientName,
    redirectUris,
    tokenEndpointAuthMethod: authMethod,
    metadata,
  });

  if (!result.ok) {
    return oauthErrorResponse(result.error);
  }

  // RFC 7591 §3.2.1 successful response is 201 Created
  return Response.json(
    {
      ...result.value,
      client_name: clientName.trim(),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: authMethod,
      ...metadata,
    },
    {
      status: 201,
      headers: noCacheHeaders(),
    },
  );
}
