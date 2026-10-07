// GET /llms.txt — Full documentation for AI agents (llms.txt spec)

import { getRuntimeEnv } from "~/lib/app-load-context.server";
import type { Route } from "./+types/llms[.]txt";

export function loader({ context }: Route.LoaderArgs) {
  const BASE = getRuntimeEnv(context).APP_URL;

  const content = `# S2

> S2 (Scoped Storage) is a file storage service. Accessible via Web UI, REST API, MCP, and WebDAV.

## Getting Started

1. Ask your S2 operator for an account, or sign up while registration is enabled at ${BASE}/login
2. Upload files from "My Files"
3. For WebDAV and REST, create an API token on the API Tokens page
4. Connect via WebDAV, REST API, or MCP (MCP uses OAuth consent instead of a token)

## WebDAV

Connect from macOS Finder, Windows Explorer, and various WebDAV clients.

### Connection Info
- URL: ${BASE}/dav
- Auth: Basic (any username, s2_ token as password)

### macOS Finder
Finder -> Go -> Connect to Server (Command+K) -> ${BASE}/dav
Username: s2 (any value works), password: your s2_ token.

### Supported Operations
PROPFIND, GET, PUT, DELETE, MKCOL, MOVE, COPY, LOCK, UNLOCK

## REST API

### Authentication
Authorization: Bearer s2_xxxxxxxxxxxx

All /api/v1/* endpoints accept either a Bearer token (s2_xxx) or a same-origin cookie session — auth is not pinned to URL prefix. Account, history, recovery, trash, and settings APIs are intentionally segregated to a separate WebUI-only surface and are not part of this public API.

All file paths are relative to the token's scope (base path).
For example, if the token's base path is /projects/, then /api/v1/files/readme.txt refers to /projects/readme.txt.

### Specification
Endpoints, request bodies, and responses: ${BASE}/openapi.yaml

## MCP

Remote MCP server at ${BASE}/mcp. Clients authenticate with OAuth consent (pick a folder and Read or Read & Write permission); API tokens are not accepted.
`;

  return new Response(content.trim(), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
