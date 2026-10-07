# Gateway

| Prefix | Role | Authentication |
|---|---|---|
| `/api/v1/*` | public REST | Bearer, or WebUI cookie |
| `/internal/*` | WebUI management (outside OpenAPI) | session cookie only; Bearer gets 403 at the edge |
| `/api/auth/*` | Better Auth | library-managed |
| `/dav/*` | WebDAV | Basic Auth; password field holds the `s2_*` token |
| `/mcp` | MCP Streamable HTTP | OAuth Bearer |
| `/oauth/*` | OAuth server ([D04-auth.md](D04-auth.md)) | per endpoint |
| `/health` | 200 / 503; only `checks.db`, `checks.storage` | none |
| `/openapi.yaml` | REST spec | none |

Cookie-backed unsafe requests compare Origin to `APP_URL`.

## REST

`openapi.yaml` is the contract; errors are `{ error: { code, message } }`. Writes use `content_version` and `If-Match` for CAS. WebDAV and MCP wrap the same services.

## WebDAV

- PROPFIND, GET, HEAD, PUT, MKCOL, MOVE, COPY, DELETE; out-of-scope paths are hidden
- Single-range reads only; multi-range and date-form If-Range fall back to 200
- LOCK/UNLOCK are stubs; concurrent edits are last-write-wins (recover via revisions)

## MCP

OAuth 2.1 + PKCE + DCR; `WWW-Authenticate` points at protected-resource metadata.
Tools: `files_list`, `files_stat`, `files_read_text`, `files_read_binary`, `files_write`, `files_write_binary`, `files_mkdir`, `files_move`, `files_delete`, limited to the consented folder and permission.
