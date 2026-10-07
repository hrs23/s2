import { redirect } from "react-router";
import { getRuntimeEnv } from "~/lib/app-load-context.server";
import { getUser } from "~/lib/auth/auth.server";
import type { Route } from "./+types/landing";

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = getRuntimeEnv(context);
  const user = await getUser(request, env);
  return redirect(user ? "/files" : "/login");
}
