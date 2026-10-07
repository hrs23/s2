// POST /api/v1/files-move — move/rename a file or directory.
// Body: { from: "src/path", to: "dest/path", overwrite?: boolean }
//
// With `overwrite=true`, mirrors WebDAV `MOVE Overwrite:T`: the destination
// file is replaced via the `replaceFile` primitive (preserving destination
// version history). Without `overwrite`, a collision returns 412 Precondition
// Failed — same as WebDAV's reply when `Overwrite: F` (or unset → defaults
// vary by client). A descendant move (cycle) returns 409.

import type { ActionFunctionArgs } from "react-router";
import { isNonEmptyPath } from "~/lib/files/paths";
import {
  err,
  mapFileOpError,
  readJson,
  withAuth,
} from "~/lib/utils/http.server";

export function action(args: ActionFunctionArgs) {
  return withAuth(
    args,
    { method: "POST" },
    async ({ request, auth, services }) => {
      const { fileService } = services;
      const parsed = await readJson<{
        from?: unknown;
        to?: unknown;
        overwrite?: unknown;
      }>(request);
      if (!parsed.ok) return parsed.response;
      const body = parsed.body;
      if (!isNonEmptyPath(body.from)) return err(400, "from is required");
      if (!isNonEmptyPath(body.to)) return err(400, "to is required");
      const overwrite = body.overwrite === true;

      // 1) Try the cheap path: plain move. If dest is free, this completes.
      const moveResult = await fileService.moveFile(auth, body.from, body.to);
      if (moveResult.ok) {
        return Response.json(
          {
            id: moveResult.nodeId,
            content_version: moveResult.contentVersion,
          },
          { status: 200 },
        );
      }

      // 2) Surface non-conflict errors as-is.
      if (moveResult.code !== "conflict") {
        return mapFileOpError(moveResult.code, {
          conflict: "Destination already exists",
        });
      }

      // 3) Conflict + overwrite=false → 412 (WebDAV Precondition Failed semantics).
      if (!overwrite) {
        return err(
          412,
          "Destination already exists (set overwrite=true to replace)",
          "precondition_failed",
        );
      }

      // 4) Conflict + overwrite=true → replace file→file (history-preserving on
      //    the destination node identity). Directory-mode replace is not
      //    supported by `replaceFile` and surfaces as type_mismatch → 409.
      const replaceResult = await fileService.replaceFile(
        auth,
        body.from,
        body.to,
      );
      if (!replaceResult.ok) {
        if (replaceResult.code === "type_mismatch") {
          return err(
            409,
            "Cannot overwrite: source/destination type mismatch",
            "type_mismatch",
          );
        }
        return mapFileOpError(replaceResult.code);
      }

      return Response.json(
        {
          id: replaceResult.nodeId,
          content_version: replaceResult.contentVersion,
          overwritten: true,
        },
        { status: 200 },
      );
    },
  );
}
