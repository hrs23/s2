// Canonical resource URI normalization (RFC 8707 audience binding).
//
// Both `/mcp` (audience-bound gateway) and `/oauth/*` (authorization server)
// need the same string for the resource indicator: the canonical URI of the
// MCP server. Centralizing it here avoids drift between the issuer
// (`/oauth/authorize`'s `resource` allowlist check, the `oauth-protected-
// resource` metadata) and the verifier (`/mcp` audience enforcement).
//
// Normalization rules:
//   - scheme lowercased (URL spec already does this)
//   - host lowercased (URL spec already does this, but we re-enforce
//     so a hand-built string still matches)
//   - default port stripped: `https://example/` not `https://example:443/`
//     (URL spec strips default ports; we preserve non-default ports as-is)
//   - trailing slash removed from path
//   - fragments / query intentionally not included
//
// Examples (all map to `https://s2.example.com/mcp`):
//   - https://s2.example.com/mcp
//   - HTTPS://S2.Example.com/mcp/
//   - https://s2.example.com/mcp?foo=1#bar    (query/fragment ignored)

/**
 * Build the canonical resource URI for the MCP gateway hosted at
 * `request.url`. Always produces the form `{scheme}://{host}[:{port}]/mcp`.
 */
export function canonicalResource(request: Request): string {
  const url = new URL(request.url);
  return normalizeResource(`${url.protocol}//${url.host}/mcp`);
}

/**
 * Normalize a resource indicator string into its canonical form
 * (lowercase scheme + host, default port stripped, no trailing slash,
 * no query / fragment). Used both for `/mcp` audience enforcement and
 * to normalize the `resource` allowlist on the authorization server.
 *
 * Returns the input untouched (after trimming) when it cannot be parsed
 * as an absolute URL; the caller's allowlist check will then reject it
 * as a non-match.
 */
export function normalizeResource(input: string): string {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }
  // URL spec already lowercases scheme + host, but lower-case `host`
  // explicitly so a literal string that bypasses URL parsing (caller
  // built `${proto}//${host}/...` from a different source) still
  // normalizes consistently.
  const host = url.host.toLowerCase();
  let path = url.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return `${url.protocol}//${host}${path}`;
}
