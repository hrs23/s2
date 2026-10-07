// /internal/oauth-grants/:id (cookie-only)
//
// DELETE: disconnect a single grant
// PATCH:  update base_path + access paths from the Connections page

import type { ActionFunctionArgs } from "react-router";
import { trimAccessPathRows } from "~/lib/access-paths/validate";
import { err, readJson, withAuth } from "~/lib/utils/http.server";

export function action(args: ActionFunctionArgs) {
  return withAuth(
    args,
    {},
    async ({ request, params, auth, services: { oauthService } }) => {
      const grantId = params.id;
      if (!grantId) return err(400, "Missing grant id");

      if (request.method === "DELETE") {
        const ok = await oauthService.revokeGrantOwned(grantId, auth.user_id);
        if (!ok) return err(404, "Grant not found");
        return new Response(null, { status: 204 });
      }

      if (request.method === "PATCH") {
        const json = await readJson<unknown>(request);
        if (!json.ok) return json.response;
        const body = json.body;
        const parsed = parseUpdateBody(body);
        if (!parsed.ok) return err(400, parsed.error);

        const result = await oauthService.updateGrantOwned(
          grantId,
          auth.user_id,
          {
            basePath: parsed.value.basePath.trim(),
            paths: trimAccessPathRows(parsed.value.paths),
          },
        );
        if (!result.ok) {
          const status = result.error.code === "not_found" ? 404 : 400;
          return err(status, result.error.message);
        }
        return new Response(null, { status: 204 });
      }

      return err(405, "Method not allowed");
    },
  );
}

interface UpdateBody {
  basePath: string;
  paths: Array<{ path: string; access: "read" | "write" }>;
}

function parseUpdateBody(
  body: unknown,
): { ok: true; value: UpdateBody } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.base_path !== "string") {
    return { ok: false, error: "base_path must be a string" };
  }
  if (!Array.isArray(b.paths)) {
    return { ok: false, error: "paths must be an array" };
  }
  const paths: UpdateBody["paths"] = [];
  for (const raw of b.paths) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: "each path entry must be an object" };
    }
    const p = raw as Record<string, unknown>;
    if (typeof p.path !== "string") {
      return { ok: false, error: "path must be a string" };
    }
    if (p.access !== "read" && p.access !== "write") {
      return { ok: false, error: "access must be 'read' or 'write'" };
    }
    paths.push({ path: p.path, access: p.access });
  }
  return { ok: true, value: { basePath: b.base_path, paths } };
}
