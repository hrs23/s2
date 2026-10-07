// GET /.well-known/oauth-protected-resource (RFC 9728)
//
// Discovery document telling clients which authorization server protects this resource.

import type { LoaderFunctionArgs } from "react-router";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  // RFC 9728 + RFC 8707: `resource` is the MCP server's canonical URI, including /mcp.
  // Advertising only the origin makes ChatGPT send it as the `resource`
  // parameter, which fails audience binding at /token (invalid_target).
  const resource = `${origin}/mcp`;

  return Response.json(
    {
      resource,
      authorization_servers: [origin],
      scopes_supported: ["files"],
      bearer_methods_supported: ["header"],
    },
    {
      headers: {
        "Cache-Control": "public, max-age=3600",
      },
    },
  );
}
