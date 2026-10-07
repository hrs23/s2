import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getAppContext, getRuntimeEnv } from "~/lib/app-load-context.server";
import { getAuthContext } from "~/lib/auth/auth.server";
import type { AuthContext } from "~/lib/auth/types";
import {
  createServices,
  type ServiceContainer,
} from "~/lib/service-factory.server";

/** Error code derived from HTTP status */
function codeFromStatus(status: number): string {
  switch (status) {
    case 400:
      return "validation_error";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 405:
      return "method_not_allowed";
    case 410:
      return "gone";
    case 412:
      return "precondition_failed";
    case 413:
      return "storage_limit_exceeded";
    default:
      return "error";
  }
}

/** Return a JSON error response: { error: { code, message } } */
export function err(status: number, message: string, code?: string): Response {
  return Response.json(
    { error: { code: code ?? codeFromStatus(status), message } },
    { status },
  );
}

/**
 * Map a FileService result `code` to the standard JSON error response.
 *
 * Routes share the same status mapping for nine codes (`invalid_path`,
 * `invalid_source_path`, `invalid_dest_path`, `forbidden`, `not_found`,
 * `conflict`, `cycle`, `quota_exceeded`, `not_implemented`); per-route
 * messages can be passed via `messages` for the codes where the human
 * meaning differs (e.g. `conflict` is "destination already exists" for
 * move/copy but "modified concurrently" for restore).
 */
export type FileOpErrorCode =
  | "invalid_path"
  | "invalid_source_path"
  | "invalid_dest_path"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "cycle"
  | "quota_exceeded"
  | "not_implemented"
  | "revision_gone";

export function mapFileOpError(
  code: FileOpErrorCode,
  messages?: Partial<Record<FileOpErrorCode, string>>,
): Response {
  switch (code) {
    case "invalid_path":
    case "invalid_source_path":
    case "invalid_dest_path":
      return err(400, messages?.[code] ?? "Invalid path");
    case "forbidden":
      return err(403, messages?.forbidden ?? "Forbidden");
    case "not_found":
      return err(404, messages?.not_found ?? "Not Found");
    case "conflict":
      return err(409, messages?.conflict ?? "Conflict");
    case "cycle":
      return err(409, messages?.cycle ?? "Cannot move a directory into itself");
    case "quota_exceeded":
      return err(413, messages?.quota_exceeded ?? "Storage limit exceeded.");
    case "not_implemented":
      return err(501, messages?.not_implemented ?? "Not implemented");
    case "revision_gone":
      // Version restore is best-effort. A revision the
      // UI displayed may have been pruned / over-quota-deleted / explicitly
      // deleted before the restore click landed. 410 Gone is the canonical
      // signal "the resource existed but is no longer available".
      return err(
        410,
        messages?.revision_gone ??
          "This revision is no longer available. It may have been overwritten by recent edits.",
        "revision_gone",
      );
  }
}

type RouteArgs = ActionFunctionArgs | LoaderFunctionArgs;

/**
 * Wrap an authenticated route handler. Order of checks is fixed:
 * method (405, only when `method` is given) -> auth (401) -> handler.
 * The handler receives the route args plus `env`, `auth` and the per-user
 * service container.
 */
export async function withAuth<A extends RouteArgs>(
  args: A,
  opts: { method?: string },
  fn: (
    ctx: A & { env: Env; auth: AuthContext; services: ServiceContainer },
  ) => Promise<Response> | Response,
): Promise<Response> {
  const { request, context } = args;
  if (opts.method && request.method !== opts.method)
    return err(405, "Method Not Allowed");

  const env = getRuntimeEnv(context);
  const auth = await getAuthContext(request, env);
  if (!auth) return err(401, "Unauthorized");

  const services = createServices(getAppContext(context), auth.user_id);
  return fn({ ...args, env, auth, services });
}

/** Parse a JSON request body; on failure returns a ready 400 response. */
export async function readJson<T>(
  request: Request,
): Promise<{ ok: true; body: T } | { ok: false; response: Response }> {
  try {
    const body: unknown = await request.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return { ok: false, response: err(400, "Invalid JSON body") };
    }
    return { ok: true, body: body as T };
  } catch {
    return { ok: false, response: err(400, "Invalid JSON body") };
  }
}
