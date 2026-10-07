// POST /api/v1/files-copy — copy a file or directory.
// Body: { from: "src/path", to: "dest/path", overwrite?: boolean }
//
// REST counterpart to WebDAV COPY and MCP files_copy. REST is the WebDAV /
// MCP superset: every file primitive on the alternative protocols must also
// be reachable from REST. Directory copy uses the `copyTree` primitive on
// FileService, which is *non-atomic by contract* — see the response schema
// (`partial: true` on the failure shape).
//
// Overwrite semantics for directories are deliberately *history-preserving*:
// existing destination files inside the subtree are updated via putFile
// (new revision), the destination node identity and version history are
// preserved. This is a divergence from the current WebDAV COPY Overwrite:T
// handler (which DELETEs the destination root before recopying, losing
// destination history). The WebDAV path is unchanged for backwards
// compatibility; see app/lib/gateway/dav.ts:handleCopy.

import type { ActionFunctionArgs } from "react-router";
import type { CopyTreeEntryResult } from "~/lib/files/file-service.server";
import { isNonEmptyPath } from "~/lib/files/paths";
import {
  err,
  mapFileOpError,
  readJson,
  withAuth,
} from "~/lib/utils/http.server";

function serializeEntry(entry: CopyTreeEntryResult) {
  if (entry.kind === "file") {
    return {
      kind: "file" as const,
      src_path: entry.srcPath,
      dest_path: entry.destPath,
      id: entry.nodeId,
      size: entry.size,
      hash: entry.hash,
      content_version: entry.contentVersion,
      existed: entry.existed,
    };
  }
  return {
    kind: "directory" as const,
    src_path: entry.srcPath,
    dest_path: entry.destPath,
    id: entry.nodeId,
    existed: entry.existed,
  };
}

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

      // Dispatch on source type. A directory source uses the recursive
      // `copyTree` primitive; a file source stays on the cheaper single-file
      // `copyFile` path. Stat'ing the source up-front keeps the response shape
      // discriminated and avoids speculatively walking a tree for a regular
      // file.
      const srcStat = await fileService.statPath(auth, body.from);
      if (!srcStat.ok) {
        return mapFileOpError(srcStat.code, {
          not_found: "Source not found",
        });
      }

      if (srcStat.isDirectory) {
        const treeResult = await fileService.copyTree(
          auth,
          body.from,
          body.to,
          overwrite,
        );
        if (!treeResult.ok) {
          // Partial-success failure: include the entries that DID copy so
          // clients can resume / reconcile. Non-atomic contract is announced
          // here via `partial: true` plus the per-entry array.
          const status =
            treeResult.code === "invalid_source_path" ||
            treeResult.code === "invalid_dest_path"
              ? 400
              : treeResult.code === "forbidden"
                ? 403
                : treeResult.code === "not_found"
                  ? 404
                  : treeResult.code === "conflict" ||
                      treeResult.code === "type_mismatch" ||
                      treeResult.code === "cycle"
                    ? 409
                    : treeResult.code === "quota_exceeded"
                      ? 413
                      : 500;
          return Response.json(
            {
              error: {
                code: treeResult.code,
                message: copyTreeMessage(treeResult.code),
                partial: treeResult.entries.length > 0,
                failed_at_src: treeResult.failedAtSrc ?? null,
                failed_at_dest: treeResult.failedAtDest ?? null,
              },
              entries: treeResult.entries.map(serializeEntry),
            },
            { status },
          );
        }
        return Response.json(
          {
            type: "directory" as const,
            entries: treeResult.entries.map(serializeEntry),
          },
          { status: 201 },
        );
      }

      // File source — single-file copy.
      const result = await fileService.copyFile(
        auth,
        body.from,
        body.to,
        overwrite,
      );
      if (!result.ok) {
        return mapFileOpError(result.code, {
          conflict: "Destination already exists",
          not_implemented: "Directory copy not dispatched correctly",
        });
      }
      return Response.json(
        {
          type: "file" as const,
          id: result.nodeId,
          size: result.size,
          hash: result.hash,
          content_version: result.contentVersion,
        },
        { status: 201 },
      );
    },
  );
}

function copyTreeMessage(code: string): string {
  switch (code) {
    case "invalid_source_path":
      return "Invalid source path";
    case "invalid_dest_path":
      return "Invalid destination path";
    case "forbidden":
      return "Forbidden";
    case "not_found":
      return "Source not found";
    case "conflict":
      return "Destination already exists";
    case "type_mismatch":
      return "Destination type conflicts with source";
    case "cycle":
      return "Cannot copy a directory into its own subtree";
    case "quota_exceeded":
      return "Storage limit exceeded.";
    default:
      return "Copy failed";
  }
}
