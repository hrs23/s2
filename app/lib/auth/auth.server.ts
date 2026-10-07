// Auth context resolution — extracts AuthContext from incoming requests.
//
// Auth method is decided by the credential itself, not by the
// URL prefix. If `Authorization: Bearer s2_*` is present we lock onto Bearer
// (returning null if it's invalid) so a leaked Bearer can't downgrade to a
// cookie that happens to be along for the ride. Without an Authorization
// header we fall back to the Better Auth session cookie. /internal/* is
// guarded against Bearer at the middleware level; this resolver is therefore
// safe to call uniformly from any handler.

import { hashToken } from "~/lib/auth/token.server";
import { TokenRepository } from "~/lib/auth/token-repository.server";
import { type User, UserRepository } from "~/lib/auth/user-repository.server";
import { createAuth } from "~/lib/auth.server";
import { createDbFromRuntimeEnv } from "~/lib/db/runtime.server";
import type { AuthContext } from "./types";

export type { User } from "~/lib/auth/user-repository.server";
export type { AuthContext } from "./types";

/**
 * Resolve auth context from credential alone (header-based):
 * Bearer if Authorization header present, cookie otherwise. Returning `null`
 * means "not authenticated" — handlers respond 401.
 */
export async function getAuthContext(
  request: Request,
  env: Env,
): Promise<AuthContext | null> {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer s2_")) {
    return resolveBearer(authHeader, env);
  }
  return resolveCookie(request, env);
}

/**
 * Resolve auth context for token-only routes (Bearer s2_*) — never falls
 * back to cookie. Returns null on non-bearer or invalid bearer.
 *
 * Use this on protocol gateways (MCP / WebDAV / REST API) that must
 * *not* accept browser cookies, so a leaked s2 web session cannot
 * impersonate an MCP client. Routes that also accept cookie sessions
 * (e.g. `/internal/*`, `/oauth/authorize`) should keep using
 * `getAuthContext`.
 */
export async function getTokenAuthContext(
  request: Request,
  env: Env,
): Promise<AuthContext | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer s2_")) return null;
  return resolveBearer(authHeader, env);
}

async function resolveBearer(
  authHeader: string,
  env: Env,
): Promise<AuthContext | null> {
  const raw = authHeader.slice("Bearer ".length);
  const hash = await hashToken(raw);

  const db = createDbFromRuntimeEnv(env);
  const tokenRepo = new TokenRepository(db);

  const row = await tokenRepo.findByHash(hash);
  if (!row) return null;

  return {
    type: "token",
    token_id: row.id,
    user_id: row.user_id,
    base_path: row.base_path,
    can_delegate: row.can_delegate,
    access_paths: row.access_paths,
    resource: row.resource,
  };
}

async function resolveCookie(
  request: Request,
  env: Env,
): Promise<AuthContext | null> {
  const session = await getBetterAuthSession(request, env);
  if (!session) return null;
  return { type: "user", user_id: session.user.id };
}

/**
 * Resolve a Better Auth session from the incoming request's cookies.
 * Returns `null` for unauthenticated requests. Used by getAuthContext (cookie
 * path) and getUser. The Better Auth instance is cached per runtime env (see app/lib/auth.server.ts).
 */
async function getBetterAuthSession(request: Request, env: Env) {
  const auth = createAuth(env);
  return auth.api.getSession({ headers: request.headers });
}

/**
 * Get authenticated user from session cookie. Returns the full User shape
 * (auth + s2 business state via UserRepository).
 */
export async function getUser(
  request: Request,
  env: Env,
): Promise<User | null> {
  const session = await getBetterAuthSession(request, env);
  if (!session) return null;

  const db = createDbFromRuntimeEnv(env);
  const userRepo = new UserRepository(db);
  // user_limits / user_storage are RLS-protected. The JOIN below
  // would silently downgrade to "unlimited / 0 bytes" without app.user_id set.
  return db.withUserTx(session.user.id, (tx) =>
    userRepo.getById(session.user.id, tx),
  );
}
