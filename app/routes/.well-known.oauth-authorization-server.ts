// GET /.well-known/oauth-authorization-server (RFC 8414)

import type { LoaderFunctionArgs } from "react-router";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const issuer = `${url.protocol}//${url.host}`;

  return Response.json(
    {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`, // DCR (RFC 7591)
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"], // Required by OAuth 2.1 and ChatGPT
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
      scopes_supported: ["files"],
    },
    {
      headers: {
        "Cache-Control": "public, max-age=3600",
      },
    },
  );
}
