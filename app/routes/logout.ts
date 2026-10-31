// Sign out endpoint — calls Better Auth's signOut server-side and redirects
// to /login. Replaces the legacy /auth/logout JWT cookie clear-and-redirect.
//
// Why a thin route rather than directly hitting /api/auth/sign-out: that
// endpoint is POST-only and Better Auth answers with JSON, not a redirect.
// The dashboard's <form method="post" action="/logout"> stays a single click.

import { redirect } from "react-router";
import { getRuntimeEnv } from "~/lib/app-load-context.server";
import { checkSameOrigin } from "~/lib/auth/origin-check.server";
import { createAuth } from "~/lib/auth.server";
import type { Route } from "./+types/logout";

async function handleSignOut(request: Request, env: Env): Promise<Response> {
  const auth = createAuth(env);

  // returnHeaders gives us the Set-Cookie that clears the session cookie. We
  // pass it through to the redirect response so the browser drops the cookie
  // on the same hop. signOut is idempotent — anonymous calls still return a
  // valid (no-op) Set-Cookie.
  const { headers } = await auth.api.signOut({
    headers: request.headers,
    returnHeaders: true,
  });

  const out = new Headers();
  for (const cookie of headers.getSetCookie()) {
    out.append("Set-Cookie", cookie);
  }
  return redirect("/login", { headers: out });
}

export async function loader() {
  return redirect("/");
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = getRuntimeEnv(context);
  if (!checkSameOrigin(request, env.APP_URL).ok) {
    return new Response("Forbidden", { status: 403 });
  }
  return handleSignOut(request, env);
}
