// GET /api/v1/files/*  — Download (file) or list (directory)
// HEAD /api/v1/files/* — File metadata
// PUT /api/v1/files/*  — Upload
// DELETE /api/v1/files/* — Delete

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { components } from "~/lib/api.generated";
import { isNonEmptyPath, stripLeadingSlashes } from "~/lib/files/paths";
import { applyDownloadSecurityHeaders } from "~/lib/utils/download-headers.server";
import {
  checkIfMatch,
  checkIfNoneMatch,
  formatETag,
} from "~/lib/utils/etag.server";
import { err, mapFileOpError, withAuth } from "~/lib/utils/http.server";

type FileItem = components["schemas"]["FileItem"];

function withTrailingSlash(request: Request, rawPath: string): string {
  if (rawPath === "" || rawPath.endsWith("/")) return rawPath;
  return new URL(request.url).pathname.endsWith("/") ? `${rawPath}/` : rawPath;
}

export function loader(args: LoaderFunctionArgs) {
  return withAuth(
    args,
    {},
    async ({ request, params, auth, services: { fileService } }) => {
      const rawPath = withTrailingSlash(request, params["*"] ?? "");
      const isDirectory =
        rawPath === "" ||
        stripLeadingSlashes(rawPath) === "" ||
        rawPath.endsWith("/");

      if (isDirectory) {
        const result = await fileService.listDirectory(auth, rawPath);
        if (!result.ok) {
          if (result.code === "invalid_path") return err(400, "Invalid path");
          return mapFileOpError(result.code);
        }
        return Response.json({
          items: result.items.map(
            (child): FileItem =>
              child.isDirectory
                ? {
                    id: child.id,
                    name: child.name,
                    type: "directory",
                    hash: null,
                    revision_id: null,
                    content_version: child.contentVersion,
                    content_type: child.contentType,
                  }
                : {
                    id: child.id,
                    name: child.name,
                    type: "file",
                    size: child.size ?? 0,
                    modified_at: child.updatedAt ?? child.createdAt,
                    hash: child.hash ?? null,
                    revision_id: child.revisionId ?? null,
                    content_version: child.contentVersion,
                    content_type: child.contentType,
                  },
          ),
        });
      }

      // HEAD — file metadata
      if (request.method === "HEAD") {
        const result = await fileService.headFile(auth, rawPath);
        if (!result.ok) {
          if (result.code === "invalid_path") return err(400, "Invalid path");
          return mapFileOpError(result.code);
        }

        // If-None-Match → 304
        if (checkIfNoneMatch(request, result.contentVersion)) {
          return new Response(null, {
            status: 304,
            headers: { ETag: formatETag(result.contentVersion) },
          });
        }

        return new Response(null, {
          headers: applyDownloadSecurityHeaders(
            new Headers({
              "Content-Length": String(result.size),
              "Content-Type": result.contentType,
              ETag: formatETag(result.contentVersion),
            }),
            result.contentType,
          ),
        });
      }

      // File download
      const result = await fileService.getFile(auth, rawPath);
      if (!result.ok) {
        if (result.code === "invalid_path") return err(400, "Invalid path");
        return mapFileOpError(result.code);
      }

      // If-None-Match → 304
      if (checkIfNoneMatch(request, result.contentVersion)) {
        return new Response(null, {
          status: 304,
          headers: { ETag: formatETag(result.contentVersion) },
        });
      }

      return new Response(result.body, {
        headers: applyDownloadSecurityHeaders(
          new Headers({
            "Content-Length": String(result.bodySize),
            "Content-Type": result.contentType,
            ETag: formatETag(result.contentVersion),
          }),
          result.contentType,
        ),
      });
    },
  );
}

export function action(args: ActionFunctionArgs) {
  return withAuth(
    args,
    {},
    async ({ request, params, auth, services: { fileService } }) => {
      const rawPath = withTrailingSlash(request, params["*"] ?? "");
      if (!isNonEmptyPath(rawPath)) return err(400, "File path is required");
      const name = rawPath.split("/").filter(Boolean).pop() ?? "";

      if (request.method === "PUT") {
        const body = await request.arrayBuffer();
        const contentType =
          request.headers.get("Content-Type") ?? "application/octet-stream";
        const isFolderMarker = rawPath.endsWith("/") && body.byteLength === 0;

        // Folder creation via mkdir (with permission check)
        if (isFolderMarker) {
          // If-None-Match: * → reject if already exists
          if (request.headers.get("If-None-Match")?.trim() === "*") {
            const stat = await fileService.statPath(auth, rawPath);
            if (!stat.ok && stat.code === "invalid_path")
              return err(400, "Invalid path");
            if (stat.ok) return err(412, "Resource already exists");
          }

          const result = await fileService.mkdir(auth, rawPath);
          if (!result.ok) {
            if (result.code === "invalid_path") return err(400, "Invalid path");
            if (result.code === "forbidden") return err(403, "Forbidden");
            // conflict = already exists; check if it's a directory (idempotent) or file (error)
            const stat = await fileService.statPath(auth, rawPath);
            if (!stat.ok || !stat.isDirectory)
              return err(409, "Path already exists as a file");
            return Response.json(
              {
                id: stat.nodeId,
                name,
                type: "directory",
              },
              { status: 200 },
            );
          }
          return Response.json(
            {
              id: result.nodeId,
              name,
              type: "directory",
            },
            { status: 201 },
          );
        }

        // If-None-Match: * → reject if file already exists (create-only)
        if (request.headers.get("If-None-Match")?.trim() === "*") {
          const stat = await fileService.statPath(auth, rawPath);
          if (!stat.ok && stat.code === "invalid_path")
            return err(400, "Invalid path");
          if (stat.ok) return err(412, "Resource already exists");
        }

        // If-Match → check content_version before writing
        const ifMatchHeader = request.headers.get("If-Match");
        if (ifMatchHeader) {
          const stat = await fileService.statPath(auth, rawPath);
          if (!stat.ok && stat.code === "invalid_path")
            return err(400, "Invalid path");
          if (stat.ok) {
            const match = checkIfMatch(request, stat.contentVersion ?? 0);
            if (match === false) {
              return err(412, "Precondition Failed");
            }
          }
        }

        const result = await fileService.putFile(
          auth,
          rawPath,
          body,
          contentType,
        );
        if (!result.ok) {
          if (result.code === "invalid_path") return err(400, "Invalid path");
          if (result.code === "forbidden") return err(403, "Forbidden");
          if (result.code === "conflict")
            return err(412, "Precondition Failed");
          return err(413, "Storage limit exceeded.");
        }

        return Response.json(
          {
            id: result.nodeId,
            name,
            size: result.size,
            hash: result.hash,
            content_version: result.contentVersion,
          },
          {
            status: 201,
            headers: { ETag: formatETag(result.contentVersion) },
          },
        );
      }

      if (request.method === "DELETE") {
        const result = await fileService.deleteFile(auth, rawPath);
        if (!result.ok) {
          if (result.code === "invalid_path") return err(400, "Invalid path");
          if (result.code === "not_found") return err(404, "Not Found");
          return err(403, "Forbidden");
        }
        return new Response(null, { status: 204 });
      }

      return err(405, "Method Not Allowed");
    },
  );
}
