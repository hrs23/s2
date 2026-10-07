// WebDAV handler
// Handles /dav/* requests forwarded from app/lib/gateway/middleware.ts

import type { AppLoadContext } from "react-router";
import { getAppContext, getRuntimeEnv } from "~/lib/app-load-context.server";
import { getAuthContext } from "~/lib/auth/auth.server";
import { QuotaService } from "~/lib/auth/quota-service.server";
import { TokenRepository } from "~/lib/auth/token-repository.server";
import type { AuthContext } from "~/lib/auth/types";
import type {
  GetFileOptions,
  IFileService,
} from "~/lib/files/file-service.server";
import { validateClientPath } from "~/lib/files/paths";
import { createServices } from "~/lib/service-factory.server";
import { readBodyBounded } from "~/lib/utils/bounded-body.server";
import { applyDownloadSecurityHeaders } from "~/lib/utils/download-headers.server";
import {
  checkIfMatch,
  checkIfNoneMatch,
  formatETag,
  parseETag,
} from "~/lib/utils/etag.server";
import {
  escapeXml,
  lockResponseXml,
  multiStatusXml,
  propfindResponse,
} from "./dav-xml";
import { parseRangeHeader } from "./range-parser";

// --- Basic auth ---

export function parseBasicAuth(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const colon = decoded.indexOf(":");
    if (colon === -1) return null;
    return decoded.slice(colon + 1);
  } catch {
    return null;
  }
}

async function authenticate(
  request: Request,
  env: Env,
): Promise<AuthContext | null> {
  const token = parseBasicAuth(request);
  if (!token) return null;
  const fakeRequest = new Request(request.url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return getAuthContext(fakeRequest, env);
}

function unauthorizedResponse(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="s2"',
      Connection: "close",
    },
  });
}

// --- Path utilities ---

export function extractDavPath(url: string): string | null {
  const u = new URL(url);
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  const prefix = "/dav";
  if (!path.startsWith(prefix)) return "/";
  const rest = path.slice(prefix.length);
  return rest || "/";
}

// --- Error mapping ---

function mapErrorToResponse(code: string): Response {
  switch (code) {
    case "invalid_path":
    case "invalid_source_path":
    case "invalid_dest_path":
      return new Response("Bad Request", { status: 400 });
    case "forbidden":
      return new Response("Forbidden", { status: 403 });
    case "not_found":
      return new Response("Not Found", { status: 404 });
    case "conflict":
      return new Response("Conflict", { status: 409 });
    case "quota_exceeded":
      return new Response("Insufficient Storage", { status: 507 });
    case "type_mismatch":
      return new Response("Conflict", { status: 409 });
    case "cycle":
      return new Response("Forbidden", { status: 403 });
    default:
      return new Response("Internal Server Error", { status: 500 });
  }
}

/**
 * Check that the parent collection exists (RFC 4918: 409 if missing).
 * Returns a 409 Response if parent is missing, null if OK.
 */
async function checkParentExists(
  auth: AuthContext,
  fileService: IFileService,
  davPath: string,
): Promise<Response | null> {
  // Compute the parent path by stripping the last segment
  const trimmed = davPath.replace(/\/+$/, "");
  const lastSlash = trimmed.lastIndexOf("/");
  const parentPath = lastSlash <= 0 ? "/" : trimmed.slice(0, lastSlash);

  if (parentPath === "/") return null; // root always exists

  // statPath handles base_path virtual root internally (returns synthetic
  // directory when segments match base_path even if not yet in DB).
  const parentStat = await fileService.statPath(auth, parentPath);
  if (!parentStat.ok) {
    if (parentStat.code === "invalid_path")
      return new Response("Bad Request", { status: 400 });
    return new Response("Conflict", { status: 409 });
  }
  if (!parentStat.isDirectory) {
    return new Response("Conflict", { status: 409 });
  }
  return null;
}

// --- Method handlers ---

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      Allow:
        "OPTIONS, HEAD, GET, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK",
      DAV: "1,2,3",
      "MS-Author-Via": "DAV",
    },
  });
}

async function handlePropfind(
  request: Request,
  auth: AuthContext,
  fileService: IFileService,
  davPath: string,
): Promise<Response> {
  const depth = request.headers.get("Depth") ?? "1";

  if (depth === "infinity") {
    return new Response("Forbidden", { status: 403 });
  }

  const stat = await fileService.statPath(auth, davPath);
  if (!stat.ok) return mapErrorToResponse(stat.code);

  const responses: string[] = [];
  const hrefBase = `/dav${davPath === "/" ? "/" : davPath}`;

  if (stat.isDirectory) {
    responses.push(
      propfindResponse({
        href: hrefBase.endsWith("/") ? hrefBase : `${hrefBase}/`,
        isCollection: true,
        size: 0,
        lastModified: new Date(stat.updatedAt ?? stat.createdAt).toUTCString(),
        contentVersion: stat.contentVersion,
      }),
    );

    if (depth !== "0") {
      const list = await fileService.listDirectory(auth, davPath);
      if (list.ok) {
        for (const child of list.items) {
          const childHref = `${hrefBase.endsWith("/") ? hrefBase : `${hrefBase}/`}${encodeURIComponent(child.name)}${child.isDirectory ? "/" : ""}`;
          responses.push(
            propfindResponse({
              href: childHref,
              isCollection: child.isDirectory,
              size: child.size ?? 0,
              lastModified: new Date(
                child.updatedAt ?? child.createdAt,
              ).toUTCString(),
              contentType: child.contentType,
              contentVersion: child.contentVersion,
            }),
          );
        }
      }
    }
  } else {
    responses.push(
      propfindResponse({
        href: `/dav${davPath}`,
        isCollection: false,
        size: stat.size ?? 0,
        lastModified: new Date(stat.updatedAt ?? stat.createdAt).toUTCString(),
        contentType: stat.contentType,
        contentVersion: stat.contentVersion,
      }),
    );
  }

  return new Response(multiStatusXml(responses), {
    status: 207,
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}

/**
 * Methods allowed on existing collections (returned in 405 Allow header per
 * RFC 9110 §15.5.6). Excludes MKCOL because the URL is mapped — RFC 4918
 * §9.3.1: "MKCOL can only be executed on an unmapped URL".
 */
const COLLECTION_ALLOWED =
  "OPTIONS, PROPFIND, PROPPATCH, COPY, MOVE, LOCK, UNLOCK, DELETE";

async function handleGet(
  request: Request,
  auth: AuthContext,
  fileService: IFileService,
  davPath: string,
): Promise<Response> {
  // Range / If-Range (RFC 9110 §14, §13.1.5). We accept strong "<n>" ETags
  // only — weak ETags and date forms drop the range entirely (200 fallback).
  const rangeParse = parseRangeHeader(request.headers.get("Range"));
  let rangeOptions: GetFileOptions | undefined;
  if (rangeParse.kind === "ok") {
    const ifRange = request.headers.get("If-Range");
    if (ifRange === null) {
      rangeOptions = { range: rangeParse.spec };
    } else {
      const ifRangeVersion = parseETag(ifRange);
      if (ifRangeVersion !== null) {
        rangeOptions = {
          range: rangeParse.spec,
          applyRangeIfContentVersion: ifRangeVersion,
        };
      }
      // Unparseable If-Range → leave rangeOptions undefined → full body (200).
    }
  }

  const result = rangeOptions
    ? await fileService.getFile(auth, davPath, rangeOptions)
    : await fileService.getFile(auth, davPath);

  if (!result.ok) {
    if (result.code === "range_not_satisfiable") {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: {
          "Content-Range": `bytes */${result.size}`,
          "Accept-Ranges": "bytes",
          ETag: formatETag(result.contentVersion),
        },
      });
    }
    // Distinguish "is a directory" (405) from "truly not found" (404)
    if (result.code === "not_found") {
      const stat = await fileService.statPath(auth, davPath);
      if (stat.ok && stat.isDirectory) {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: COLLECTION_ALLOWED },
        });
      }
    }
    return mapErrorToResponse(result.code);
  }

  if (checkIfNoneMatch(request, result.contentVersion)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: formatETag(result.contentVersion) },
    });
  }

  if (result.servedRange) {
    const { offset, length } = result.servedRange;
    return new Response(result.body, {
      status: 206,
      headers: applyDownloadSecurityHeaders(
        new Headers({
          "Content-Length": String(result.bodySize),
          "Content-Range": `bytes ${offset}-${offset + length - 1}/${result.size}`,
          "Content-Type": result.contentType,
          "Accept-Ranges": "bytes",
          ETag: formatETag(result.contentVersion),
        }),
        result.contentType,
      ),
    });
  }

  return new Response(result.body, {
    headers: applyDownloadSecurityHeaders(
      new Headers({
        "Content-Length": String(result.bodySize),
        "Content-Type": result.contentType,
        "Accept-Ranges": "bytes",
        ETag: formatETag(result.contentVersion),
      }),
      result.contentType,
    ),
  });
}

async function handleHead(
  request: Request,
  auth: AuthContext,
  fileService: IFileService,
  davPath: string,
): Promise<Response> {
  const result = await fileService.headFile(auth, davPath);

  if (!result.ok) {
    if (result.code === "not_found") {
      const stat = await fileService.statPath(auth, davPath);
      if (stat.ok && stat.isDirectory) {
        return new Response(null, {
          status: 405,
          headers: { Allow: COLLECTION_ALLOWED },
        });
      }
    }
    return mapErrorToResponse(result.code);
  }

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
        "Accept-Ranges": "bytes",
        ETag: formatETag(result.contentVersion),
      }),
      result.contentType,
    ),
  });
}

async function handlePut(
  request: Request,
  auth: AuthContext,
  fileService: IFileService,
  davPath: string,
  remainingBytes: () => Promise<number>,
): Promise<Response> {
  if (davPath === "/") return new Response("Bad Request", { status: 400 });

  // If-Match precondition check (RFC 9110 §13.1.1)
  const ifMatchHeader = request.headers.get("If-Match");
  if (ifMatchHeader) {
    const stat = await fileService.statPath(auth, davPath);
    if (!stat.ok) {
      // If-Match requires an existing resource; missing → 412
      return new Response("Precondition Failed", { status: 412 });
    }
    const match = checkIfMatch(request, stat.contentVersion);
    if (match === false) {
      return new Response("Precondition Failed", { status: 412 });
    }
  }

  // If-None-Match: * — reject if resource already exists
  if (request.headers.get("If-None-Match")?.trim() === "*") {
    const stat = await fileService.statPath(auth, davPath);
    if (stat.ok) {
      return new Response("Precondition Failed", { status: 412 });
    }
  }

  // RFC 4918: parent collection must exist
  const parentErr = await checkParentExists(auth, fileService, davPath);
  if (parentErr) return parentErr;

  const maxBytes = await remainingBytes();
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return mapErrorToResponse("quota_exceeded");
  }
  const body = await readBodyBounded(request, maxBytes);
  if (!body) return mapErrorToResponse("quota_exceeded");
  const contentType =
    request.headers.get("Content-Type") ?? "application/octet-stream";

  const result = await fileService.putFile(auth, davPath, body, contentType);
  if (!result.ok) return mapErrorToResponse(result.code);

  return new Response(null, {
    status: result.existed ? 204 : 201,
    headers: { ETag: formatETag(result.contentVersion) },
  });
}

async function handleDelete(
  auth: AuthContext,
  fileService: IFileService,
  davPath: string,
): Promise<Response> {
  // Block deletion of the real root or the virtual root (base_path directory)
  if (davPath === "/") return new Response("Bad Request", { status: 400 });

  const result = await fileService.deleteFile(auth, davPath);
  if (!result.ok) return mapErrorToResponse(result.code);

  return new Response(null, { status: 204 });
}

async function handleMkcol(
  request: Request,
  auth: AuthContext,
  fileService: IFileService,
  davPath: string,
): Promise<Response> {
  // Scope root is always a mapped collection — RFC 4918 §9.3.1: "MKCOL can
  // only be executed on an unmapped URL". Mirrors the "already exists" branch
  // below and lets WebDAV clients idempotently MKCOL their base URL on startup.
  if (davPath === "/") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: COLLECTION_ALLOWED },
    });
  }

  // MKCOL with body is unsupported
  const body = await request.arrayBuffer();
  if (body.byteLength > 0) {
    return new Response("Unsupported Media Type", { status: 415 });
  }

  // RFC 4918: parent collection must exist
  const parentErr = await checkParentExists(auth, fileService, davPath);
  if (parentErr) return parentErr;

  // Check if already exists — RFC 4918 §9.3.1: 405 (Allow header per RFC 9110 §15.5.6)
  const existing = await fileService.statPath(auth, davPath);
  if (existing.ok) {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: COLLECTION_ALLOWED },
    });
  }

  const result = await fileService.mkdir(auth, davPath);
  if (!result.ok) return mapErrorToResponse(result.code);

  return new Response(null, { status: 201 });
}

// --- COPY ---
//
// The recursive walk lives in `FileService.copyTree`. The dav
// transport keeps responsibility for:
//   - Destination header parse + well-formedness validation
//   - RFC 4918 status mapping (412/204/201)
//   - Depth: 0 special case (mkdir without descent)
//   - Parent-collection existence check
//   - The historical "DELETE destination, then recreate" semantics on
//     `Overwrite: T` (intentionally divergent from REST `/api/v1/files-copy`,
//     which uses history-preserving copyTree directly).

async function handleCopy(
  request: Request,
  auth: AuthContext,
  fileService: IFileService,
  davPath: string,
): Promise<Response> {
  const destHeader = request.headers.get("Destination");
  if (!destHeader)
    return new Response("Bad Request: Destination header required", {
      status: 400,
    });

  const destUrl = new URL(destHeader, request.url);
  const destDavPath = extractDavPath(destUrl.href);
  if (destDavPath === null) return new Response("Bad Request", { status: 400 });

  if (davPath === "/" || destDavPath === "/")
    return new Response("Bad Request", { status: 400 });

  // Validate destination well-formedness before any transport-side path logic
  // (the descendant check below operates on raw strings and would match
  // obvious traversal patterns). Semantic validation still happens in
  // fileService.copyFile / copyTree.
  const destPathError = validateClientPath(destDavPath);
  if (destPathError) return new Response(destPathError, { status: 400 });

  const overwrite = request.headers.get("Overwrite") !== "F";
  const depth = request.headers.get("Depth") ?? "infinity";

  // Reject COPY into a descendant of source (would cause infinite recursion).
  // copyTree also enforces this, but the dav layer needs an explicit early
  // reject so the response code matches RFC 4918 conventions (403 Forbidden
  // for cycles on this protocol — see mapErrorToResponse).
  const normSrc = davPath.replace(/\/+$/, "");
  const normDest = destDavPath.replace(/\/+$/, "");
  if (normDest.startsWith(`${normSrc}/`)) {
    return new Response("Conflict", { status: 409 });
  }

  // RFC 4918: destination parent collection must exist
  const parentErr = await checkParentExists(auth, fileService, destDavPath);
  if (parentErr) return parentErr;

  // Verify source exists before touching destination
  const srcStat = await fileService.statPath(auth, davPath);
  if (!srcStat.ok) return mapErrorToResponse(srcStat.code);

  // Check if destination exists
  const destStat = await fileService.statPath(auth, destDavPath);
  const destExists = destStat.ok;

  if (destExists && !overwrite) {
    return new Response("Precondition Failed", { status: 412 });
  }

  // Delete destination only after source is verified. WebDAV preserves the
  // delete+recreate pattern here: any existing destination subtree is moved
  // to trash before the copy proceeds. The REST path takes the
  // history-preserving merge route instead — see app/routes/api.files-copy.ts.
  if (destExists) {
    const delResult = await fileService.deleteFile(auth, destDavPath);
    if (!delResult.ok) return mapErrorToResponse(delResult.code);
  }

  // File source: single-file copy. copyFile rejects directories — but here
  // we've already discriminated on srcStat.
  if (!srcStat.isDirectory) {
    const copyResult = await fileService.copyFile(
      auth,
      davPath,
      destDavPath,
      // After the explicit delete above, dest is gone, so overwrite=false
      // is sufficient for the underlying putFile guard.
      false,
    );
    if (!copyResult.ok) return mapErrorToResponse(copyResult.code);
    return new Response(null, { status: destExists ? 204 : 201 });
  }

  // Depth: 0 on a directory — create the directory but don't copy children.
  // This must not call copyTree (which always walks).
  if (depth === "0") {
    const mkdirResult = await fileService.mkdir(auth, destDavPath);
    if (!mkdirResult.ok) return mapErrorToResponse(mkdirResult.code);
    return new Response(null, { status: destExists ? 204 : 201 });
  }

  // Directory: delegate the walk to the service. Pass overwrite=false because
  // the dav layer already cleared dest above (delete+recreate semantics);
  // copyTree's history-preserving merge logic is therefore not exercised on
  // this protocol.
  const treeResult = await fileService.copyTree(
    auth,
    davPath,
    destDavPath,
    false,
  );
  if (!treeResult.ok) return mapErrorToResponse(treeResult.code);

  return new Response(null, { status: destExists ? 204 : 201 });
}

async function handleMove(
  request: Request,
  auth: AuthContext,
  fileService: IFileService,
  davPath: string,
): Promise<Response> {
  const destHeader = request.headers.get("Destination");
  if (!destHeader)
    return new Response("Bad Request: Destination header required", {
      status: 400,
    });

  const destUrl = new URL(destHeader, request.url);
  const destDavPath = extractDavPath(destUrl.href);
  if (destDavPath === null) return new Response("Bad Request", { status: 400 });

  if (davPath === "/" || destDavPath === "/")
    return new Response("Bad Request", { status: 400 });

  // Validate destination well-formedness. checkParentExists below constructs
  // paths from raw segments; a malformed dest would otherwise propagate.
  const destPathError = validateClientPath(destDavPath);
  if (destPathError) return new Response(destPathError, { status: 400 });

  // RFC 4918: destination parent collection must exist
  const parentErr = await checkParentExists(auth, fileService, destDavPath);
  if (parentErr) return parentErr;

  const overwrite = request.headers.get("Overwrite") !== "F";

  if (overwrite) {
    // Try move first
    const moveResult = await fileService.moveFile(auth, davPath, destDavPath);
    if (moveResult.ok) return new Response(null, { status: 201 });
    if (moveResult.code !== "conflict")
      return mapErrorToResponse(moveResult.code);

    // Conflict: dest exists — try replace (file→file, preserves dst history)
    const replaceResult = await fileService.replaceFile(
      auth,
      davPath,
      destDavPath,
    );
    if (replaceResult.ok) return new Response(null, { status: 204 });
    if (replaceResult.code === "type_mismatch")
      return new Response("Conflict", { status: 409 });
    return mapErrorToResponse(replaceResult.code);
  }

  // Overwrite: F
  const result = await fileService.moveFile(auth, davPath, destDavPath);
  if (!result.ok) {
    if (result.code === "conflict") {
      return new Response("Precondition Failed", { status: 412 });
    }
    return mapErrorToResponse(result.code);
  }
  return new Response(null, { status: 201 });
}

// --- Fake Lock (Class 2) ---

function handleLock(davPath: string): Response {
  const token = crypto.randomUUID();
  const href = `/dav${davPath}`;
  return new Response(lockResponseXml(href, token), {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Lock-Token": `<urn:uuid:${token}>`,
    },
  });
}

function handleUnlock(): Response {
  return new Response(null, { status: 204 });
}

function handleProppatch(davPath: string): Response {
  const href = `/dav${davPath}`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>${escapeXml(href)}</D:href>
    <D:propstat>
      <D:prop/>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

  return new Response(xml, {
    status: 207,
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}

// --- Main handler ---

export async function handleDavRequest(
  request: Request,
  context: AppLoadContext,
): Promise<Response> {
  const env = getRuntimeEnv(context);
  const method = request.method.toUpperCase();
  const davPath = extractDavPath(request.url);
  if (davPath === null) return new Response("Bad Request", { status: 400 });

  if (method === "OPTIONS") {
    return handleOptions();
  }

  // Path well-formedness (traversal, null byte) is a format-level check that
  // Transport owns: LOCK/PROPPATCH are stubs that never reach FileService, so
  // relying purely on parseClientPath would leak malformed paths into response
  // bodies. Semantic checks (scope, existence, permissions) remain Service's
  // job.
  const pathError = validateClientPath(davPath);
  if (pathError) return new Response(pathError, { status: 400 });

  const auth = await authenticate(request, env);
  if (!auth) return unauthorizedResponse();

  const { fileService, db, userRepo } = createServices(
    getAppContext(context),
    auth.user_id,
  );

  switch (method) {
    case "PROPFIND":
      return handlePropfind(request, auth, fileService, davPath);
    case "GET":
      return handleGet(request, auth, fileService, davPath);
    case "HEAD":
      return handleHead(request, auth, fileService, davPath);
    case "PUT":
      return handlePut(request, auth, fileService, davPath, async () => {
        const quota = new QuotaService(userRepo, new TokenRepository(db));
        const { used, limit } = await db.withUserTx(auth.user_id, (tx) =>
          quota.checkStorage(auth.user_id, 0, tx),
        );
        return limit === 0 ? Number.POSITIVE_INFINITY : limit - used;
      });
    case "DELETE":
      return handleDelete(auth, fileService, davPath);
    case "MKCOL":
      return handleMkcol(request, auth, fileService, davPath);
    case "COPY":
      return handleCopy(request, auth, fileService, davPath);
    case "MOVE":
      return handleMove(request, auth, fileService, davPath);
    case "LOCK":
      return handleLock(davPath);
    case "UNLOCK":
      return handleUnlock();
    case "PROPPATCH":
      return handleProppatch(davPath);
    default:
      return new Response("Method Not Allowed", { status: 405 });
  }
}
