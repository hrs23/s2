import type { ActionFunctionArgs } from "react-router";
import { getAppContext, getRuntimeEnv } from "~/lib/app-load-context.server";
import { getUser } from "~/lib/auth/auth.server";
import { createServices } from "~/lib/service-factory.server";
import { err } from "~/lib/utils/http.server";

/**
 * POST /internal/account/delete
 *
 * Permanently deletes the authenticated user's account:
 * DELETE the user row. CASCADE removes related DB state and the tombstone
 * trigger queues stored chunks for asynchronous cleanup.
 */
export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return err(405, "Method not allowed");
  }

  const env = getRuntimeEnv(context);
  const user = await getUser(request, env);
  if (!user) {
    return err(401, "Unauthorized");
  }

  const { userRepo } = createServices(getAppContext(context), user.id);

  // Delete user row. CASCADE + tombstone trigger handle the
  //    storage cleanup asynchronously via storage-gc.
  await userRepo.delete(user.id);

  // Better Auth's session row was CASCADE-deleted with the
  //    user; the cookie will be ignored on the next request. Client-side
  //    redirect to /login completes the UX.
  return Response.json({ ok: true });
}
