import {
  index,
  layout,
  type RouteConfig,
  route,
} from "@react-router/dev/routes";

export default [
  index("routes/landing.tsx"),
  route("docs", "routes/docs.tsx", [
    index("routes/docs._index.tsx"),
    route("webdav", "routes/docs.webdav.tsx"),
    route("mcp", "routes/docs.mcp.tsx"),
    route("rest", "routes/docs.rest.tsx"),
  ]),
  // Auth UI: password is the primary factor; passkey and TOTP are optional.
  route("login", "routes/login.tsx"),
  // TOTP / recovery-code prompt after a successful
  // password sign-in for users with 2FA enabled. Better Auth's twoFactor
  // plugin sets a short-lived pending cookie; this page consumes it via
  // authClient.twoFactor.verifyTotp / verifyBackupCode.
  route("login/two-factor", "routes/login.two-factor.tsx"),
  route("signup", "routes/signup.tsx"),
  route("forgot-password", "routes/forgot-password.tsx"),
  route("reset-password", "routes/reset-password.tsx"),

  // Sign-out clears the Better Auth session cookie and redirects to /login.
  route("logout", "routes/logout.ts"),

  // Better Auth catch-all.
  route("api/auth/*", "routes/api.auth.$.ts"),

  // LLM documentation
  route("llms.txt", "routes/llms[.]txt.ts"),

  // Dashboard (login required)
  layout("routes/_dashboard.tsx", [
    route("tokens", "routes/_dashboard.tokens.tsx"),
    route("connections", "routes/_dashboard.connections.tsx"),
    route("files", "routes/_dashboard.files.tsx"),
    route("settings", "routes/_dashboard.settings.tsx"),
  ]),

  // Health check (no auth)
  route("health", "routes/health.ts"),

  // /api/v1/* (Bearer + cookie, OpenAPI public surface).
  // Auth method is decided by the credential header (Bearer vs cookie),
  // not by URL prefix.
  //
  // Sibling action endpoints follow the `/files-<verb>` pattern (move,
  // copy, mkdir, restore). Adding new file actions: keep the pattern.
  // Recovery / cookie-only equivalents live under /internal/* (e.g.
  // /internal/files-restore).
  route("api/v1/token", "routes/api.token.ts"), // GET introspection (Bearer-only)
  route("api/v1/tokens", "routes/api.tokens.ts"), // POST create / delegation
  route("api/v1/tokens/:id", "routes/api.tokens.$id.ts"), // DELETE revoke
  route("api/v1/files/*", "routes/api.files.$.ts"),
  route("api/v1/files-move", "routes/api.files-move.ts"),
  route("api/v1/files-copy", "routes/api.files-copy.ts"),
  route("api/v1/files-mkdir", "routes/api.files-mkdir.ts"),
  route("api/v1/uploads", "routes/api.uploads.ts"),
  route("api/v1/uploads/:id", "routes/api.uploads.$id.ts"),
  route("api/v1/uploads/:id/:chunk", "routes/api.uploads.$id.$chunk.ts"),
  route("api/v1/uploads/:id/complete", "routes/api.uploads.$id.complete.ts"),

  // /internal/* (cookie + same-origin, Bearer rejected at edge,
  // OpenAPI-exempt). WebUI management surface for account, history,
  // recovery, and settings.
  route("internal/account", "routes/internal.account.ts"),
  route("internal/account/delete", "routes/internal.account.delete.ts"),
  route("internal/tokens", "routes/internal.tokens.ts"),
  route("internal/tokens/:id", "routes/internal.tokens.$id.ts"),
  route(
    "internal/tokens/:id/access-paths",
    "routes/internal.tokens.$id.access-paths.ts",
  ),
  route("internal/tokens/:id/issue", "routes/internal.tokens.$id.issue.ts"),
  route("internal/tokens/:id/rotate", "routes/internal.tokens.$id.rotate.ts"),
  route("internal/tokens/:id/secret", "routes/internal.tokens.$id.secret.ts"),
  route("internal/oauth-grants", "routes/internal.oauth-grants.ts"),
  route("internal/oauth-grants/:id", "routes/internal.oauth-grants.$id.ts"),
  route("internal/revisions", "routes/internal.revisions.ts"),
  route(
    "internal/revisions/:revisionId",
    "routes/internal.revisions.$revisionId.ts",
  ),
  route("internal/files-restore", "routes/internal.files-restore.ts"),
  route("internal/trash", "routes/internal.trash.ts"),
  route("internal/trash/:id", "routes/internal.trash.$id.ts"),
  route("internal/trash/:id/restore", "routes/internal.trash.$id.restore.ts"),
  // OAuth 2.1 Authorization Server + DCR
  route("oauth/authorize", "routes/oauth.authorize.tsx"),
  route("oauth/token", "routes/oauth.token.ts"),
  route("oauth/register", "routes/oauth.register.ts"),
  route(
    ".well-known/oauth-authorization-server",
    "routes/.well-known.oauth-authorization-server.ts",
  ),
  route(
    ".well-known/oauth-protected-resource",
    "routes/.well-known.oauth-protected-resource.ts",
  ),

  // Remote MCP server (Streamable HTTP, stateless)
  route("mcp", "routes/mcp.ts"),

  // OpenAPI spec — served at root.
  route("openapi.yaml", "routes/openapi[.]yaml.ts"),

  // API catch-all — unmatched /api/v1/* paths return JSON 404
  // (keeps /api/v1/* protocol-neutral; avoids HTML from root ErrorBoundary).
  route("api/v1/*", "routes/api.v1.$.ts"),
] satisfies RouteConfig;
