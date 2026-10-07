// POST /api/v1/files-mkdir — create a directory.
// Body: { path: "some/dir" }
//
// REST counterpart to WebDAV MKCOL and MCP files_mkdir. Idempotent: when the
// path already exists as a directory, returns 200 with the existing node;
// when it exists as a file, returns 409.

import type { ActionFunctionArgs } from "react-router";
import {
  err,
  mapFileOpError,
  readJson,
  withAuth,
} from "~/lib/utils/http.server";

export async function action(args: ActionFunctionArgs) {
  return withAuth(
    args,
    { method: "POST" },
    async ({ request, auth, services }) => {
      const parsed = await readJson<{ path?: unknown }>(request);
      if (!parsed.ok) return parsed.response;
      const body = parsed.body;
      if (typeof body.path !== "string" || !body.path.replace(/^\/+/, ""))
        return err(400, "path is required");
      const path = body.path;
      const name = path.split("/").filter(Boolean).pop() ?? "";

      const { fileService } = services;
      const result = await fileService.mkdir(auth, path);

      if (!result.ok) {
        if (result.code !== "conflict") return mapFileOpError(result.code);
        const stat = await fileService.statPath(auth, path);
        if (!stat.ok || !stat.isDirectory)
          return err(409, "Path already exists as a file");
        return Response.json(
          { id: stat.nodeId, name, type: "directory" },
          { status: 200 },
        );
      }

      return Response.json(
        { id: result.nodeId, name, type: "directory" },
        { status: 201 },
      );
    },
  );
}
