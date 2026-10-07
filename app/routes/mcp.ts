// POST/GET /mcp — Remote MCP gateway, Streamable HTTP
//
// MCP is a protocol gateway to FileService, alongside REST and WebDAV.
// This module only handles:
//   - the HTTP entry point, bearer auth and RFC 8707 audience binding
//   - the MCP wire format (text/binary content blocks, structured errors)
//   - text/utf-8 <-> base64 encoding conversion
// Domain logic is delegated to FileService.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { getAppContext, getRuntimeEnv } from "~/lib/app-load-context.server";
import { getTokenAuthContext } from "~/lib/auth/auth.server";
import type { AuthContext } from "~/lib/auth/types";
import type { FileService } from "~/lib/files/file-service.server";
import { canonicalResource } from "~/lib/oauth/canonical-resource";
import { createServices } from "~/lib/service-factory.server";

// ---------------------------------------------------------------------------
// Auth (Bearer + RFC 8707 audience binding)
// ---------------------------------------------------------------------------

function unauthorized(request: Request): Response {
  const resourceMetadataUrl = `${new URL(request.url).origin}/.well-known/oauth-protected-resource`;
  return new Response(null, {
    status: 401,
    headers: {
      "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}", scope="files"`,
    },
  });
}

/**
 * Enforce RFC 8707 audience binding.
 *
 * The token must be a Bearer token (cookie sessions are rejected at the
 * gateway level — MCP is a machine-to-machine API) AND its bound
 * `resource` must equal the canonical request URI. Legacy null-resource
 * tokens are rejected here: they were issued without RFC 8707 binding
 * (existing REST / WebDAV Bearer tokens) and must not grant MCP access.
 */
function assertAudience(
  auth: AuthContext | null,
  expectedResource: string,
): auth is Extract<AuthContext, { type: "token" }> {
  if (!auth || auth.type !== "token") return false;
  return auth.resource === expectedResource;
}

// ---------------------------------------------------------------------------
// Error contract (MCP-style structured tool result)
// ---------------------------------------------------------------------------

/**
 * Normalized error code surfaced to MCP clients. Kept small + stable so LLMs
 * can branch on it. Maps loosely onto FileService codes plus gateway-specific
 * conditions (encoding / decoding / type mismatch).
 */
type ErrorCode =
  | "invalid_path"
  | "out_of_scope"
  | "not_found"
  | "is_directory"
  | "not_a_directory"
  | "conflict"
  | "quota_exceeded"
  | "invalid_utf8"
  | "invalid_base64"
  | "unsupported_media_type"
  | "internal";

interface ToolErrorPayload {
  [key: string]: unknown;
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { code: ErrorCode; message: string };
}

function errorResult(code: ErrorCode, message: string): ToolErrorPayload {
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { code, message },
  };
}

type FsErrorCode =
  | "invalid_path"
  | "forbidden"
  | "not_found"
  | "quota_exceeded"
  | "conflict";

/** Normalize FileService error codes into MCP-facing codes. */
function normalizeFsCode(code: FsErrorCode): ErrorCode {
  return code === "forbidden" ? "out_of_scope" : code;
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function bufferToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBuffer(base64: string): Uint8Array | null {
  try {
    const bin = atob(base64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Strict UTF-8 decode. Returns null when bytes are not valid UTF-8. */
function utf8DecodeStrict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function joinPath(parent: string, name: string): string {
  if (parent === "/" || parent === "") return `/${name}`;
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

/** Best-effort MIME guess from a filename extension. Used as `files_write` default. */
function guessMimeFromPath(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "md":
      return "text/markdown; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "csv":
      return "text/csv; charset=utf-8";
    case "txt":
      return "text/plain; charset=utf-8";
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
      return "text/plain; charset=utf-8";
    case "yml":
    case "yaml":
      return "application/yaml; charset=utf-8";
    case "xml":
      return "application/xml; charset=utf-8";
    default:
      return "text/plain; charset=utf-8";
  }
}

/**
 * Resolve the "directory vs not-found" ambiguity that `FileService.getFile`
 * collapses to `not_found`. When a read tool sees `not_found`, peek at
 * `statPath` so the caller gets `is_directory` when the path *does* exist
 * but is not a regular file.
 */
async function classifyReadNotFound(
  fileService: FileService,
  auth: AuthContext,
  path: string,
): Promise<ErrorCode> {
  const stat = await fileService.statPath(auth, path);
  if (stat.ok && stat.isDirectory) return "is_directory";
  return "not_found";
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

function buildServer(fileService: FileService, auth: AuthContext): McpServer {
  const server = new McpServer({ name: "s2", version: "0.1.0" });

  // ---- files_list -----------------------------------------------------------

  const fileEntryShape = {
    path: z.string(),
    name: z.string(),
    kind: z.enum(["file", "directory"]),
    size: z.number().nullable(),
    content_version: z.number(),
    updated_at: z.string().nullable(),
  };

  server.registerTool(
    "files_list",
    {
      title: "List directory",
      description:
        "List entries (files and subdirectories) in a directory. " +
        "Paths are absolute starting with `/`, resolved against the user's s2 root. " +
        "Returns name, kind (file/directory), size, content_version, and updated_at for each entry. " +
        "Use this to discover files before reading or editing them.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute directory path, e.g. `/notes` or `/`. Trailing slash optional.",
          ),
      },
      outputSchema: { entries: z.array(z.object(fileEntryShape)) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }) => {
      const r = await fileService.listDirectory(auth, path);
      if (!r.ok) {
        return errorResult(normalizeFsCode(r.code), `failed to list ${path}`);
      }
      const entries = r.items.map((e) => ({
        path: joinPath(path, e.name),
        name: e.name,
        kind: e.isDirectory ? ("directory" as const) : ("file" as const),
        size: e.size,
        content_version: e.contentVersion,
        updated_at: e.updatedAt,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify({ entries }) }],
        structuredContent: { entries },
      };
    },
  );

  // ---- files_stat -----------------------------------------------------------

  const statShape = {
    path: z.string(),
    kind: z.enum(["file", "directory"]),
    size: z.number().nullable(),
    content_type: z.string(),
    content_version: z.number(),
    updated_at: z.string().nullable(),
  };

  server.registerTool(
    "files_stat",
    {
      title: "Stat path",
      description:
        "Get metadata for a file or directory without reading its content. " +
        "Returns kind (file/directory), size, content_type, content_version, and updated_at. " +
        "Use before writing to check existence, or before reading to pick the right read tool based on content_type.",
      inputSchema: {
        path: z.string().describe("Absolute path to a file or directory."),
      },
      outputSchema: statShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }) => {
      const r = await fileService.statPath(auth, path);
      if (!r.ok) {
        return errorResult(normalizeFsCode(r.code), `failed to stat ${path}`);
      }
      const out = {
        path,
        kind: r.isDirectory ? ("directory" as const) : ("file" as const),
        size: r.size,
        content_type: r.contentType,
        content_version: r.contentVersion,
        updated_at: r.updatedAt,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(out) }],
        structuredContent: out,
      };
    },
  );

  // ---- files_read_text ------------------------------------------------------

  const readTextShape = {
    path: z.string(),
    content: z.string(),
    content_type: z.string(),
    size: z.number(),
    content_version: z.number(),
  };

  server.registerTool(
    "files_read_text",
    {
      title: "Read text file",
      description:
        "Read a file's contents as UTF-8 text. " +
        "Use this for markdown, JSON, source code, plain text, etc. " +
        "If the file is not valid UTF-8 (e.g. images, PDFs, archives), " +
        "this tool returns an `invalid_utf8` error — fall back to `files_read_binary` in that case. " +
        "Directories return `is_directory`; missing paths return `not_found`.",
      inputSchema: {
        path: z.string().describe("Absolute path to a regular file."),
      },
      outputSchema: readTextShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }) => {
      const r = await fileService.getFile(auth, path);
      if (!r.ok) {
        const code =
          r.code === "not_found"
            ? await classifyReadNotFound(fileService, auth, path)
            : normalizeFsCode(r.code);
        return errorResult(code, `failed to read ${path}`);
      }
      const buf = await new Response(r.body).arrayBuffer();
      const bytes = new Uint8Array(buf);
      const text = utf8DecodeStrict(bytes);
      if (text === null) {
        return errorResult(
          "invalid_utf8",
          `${path} is not valid UTF-8; use files_read_binary instead`,
        );
      }
      const out = {
        path,
        content: text,
        content_type: r.contentType,
        size: r.size,
        content_version: r.contentVersion,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(out) }],
        structuredContent: out,
      };
    },
  );

  // ---- files_read_binary ----------------------------------------------------

  const readBinaryShape = {
    path: z.string(),
    content_base64: z.string(),
    mime_type: z.string(),
    size: z.number(),
    content_version: z.number(),
  };

  server.registerTool(
    "files_read_binary",
    {
      title: "Read binary file",
      description:
        "Read a file's contents as base64-encoded bytes plus the stored MIME type. " +
        "Use this for images, PDFs, archives, or any non-text file. " +
        "For text files, prefer `files_read_text` to avoid base64 overhead and decoding errors. " +
        "Directories return `is_directory`; missing paths return `not_found`.",
      inputSchema: {
        path: z.string().describe("Absolute path to a regular file."),
      },
      outputSchema: readBinaryShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }) => {
      const r = await fileService.getFile(auth, path);
      if (!r.ok) {
        const code =
          r.code === "not_found"
            ? await classifyReadNotFound(fileService, auth, path)
            : normalizeFsCode(r.code);
        return errorResult(code, `failed to read ${path}`);
      }
      const buf = await new Response(r.body).arrayBuffer();
      const out = {
        path,
        content_base64: bufferToBase64(new Uint8Array(buf)),
        mime_type: r.contentType,
        size: r.size,
        content_version: r.contentVersion,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(out) }],
        structuredContent: out,
      };
    },
  );

  // ---- files_write (text) ---------------------------------------------------

  const writeShape = {
    path: z.string(),
    size: z.number(),
    content_version: z.number(),
  };

  server.registerTool(
    "files_write",
    {
      title: "Write text file",
      description:
        "Create or overwrite a file with UTF-8 text content. " +
        "Pass `content` as a plain string — do NOT base64-encode it. " +
        "Overwrites any existing file at the path without warning. " +
        "Use `mime_type` to record a specific MIME (e.g. `application/json; charset=utf-8`); " +
        "if omitted, the MIME is guessed from the file extension and falls back to `text/plain; charset=utf-8`. " +
        "For non-text content (images, PDFs, archives) use `files_write_binary`.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute file path, e.g. `/notes/today.md`. Missing parent directories are created.",
          ),
        content: z
          .string()
          .describe("UTF-8 text content. Plain string — do not base64-encode."),
        mime_type: z
          .string()
          .optional()
          .describe(
            "Optional MIME type to store, e.g. `text/markdown; charset=utf-8`. Defaults to a guess from the extension, then `text/plain; charset=utf-8`.",
          ),
      },
      outputSchema: writeShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, content, mime_type }) => {
      const bytes = utf8Encode(content);
      const contentType = mime_type ?? guessMimeFromPath(path);
      const r = await fileService.putFile(
        auth,
        path,
        bytes.buffer as ArrayBuffer,
        contentType,
      );
      if (!r.ok) {
        return errorResult(normalizeFsCode(r.code), `failed to write ${path}`);
      }
      const out = {
        path,
        size: bytes.byteLength,
        content_version: r.contentVersion,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(out) }],
        structuredContent: out,
      };
    },
  );

  // ---- files_write_binary ---------------------------------------------------

  server.registerTool(
    "files_write_binary",
    {
      title: "Write binary file",
      description:
        "Create or overwrite a file with binary content provided as base64. " +
        "Use this for images, PDFs, archives — any non-text content. " +
        "For UTF-8 text, prefer `files_write`. " +
        "Overwrites any existing file at the path without warning. " +
        "`mime_type` is required so the file is served with the correct Content-Type on read-back.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute file path. Missing parent directories are created.",
          ),
        content_base64: z
          .string()
          .describe(
            "Base64-encoded file bytes (standard base64, no data: URI prefix).",
          ),
        mime_type: z
          .string()
          .describe(
            "MIME type to store, e.g. `image/png` or `application/pdf`. Used as the Content-Type on subsequent reads.",
          ),
      },
      outputSchema: writeShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, content_base64, mime_type }) => {
      const bytes = base64ToBuffer(content_base64);
      if (!bytes) {
        return errorResult(
          "invalid_base64",
          "content_base64 is not valid base64",
        );
      }
      const r = await fileService.putFile(
        auth,
        path,
        bytes.buffer as ArrayBuffer,
        mime_type,
      );
      if (!r.ok) {
        return errorResult(normalizeFsCode(r.code), `failed to write ${path}`);
      }
      const out = {
        path,
        size: bytes.byteLength,
        content_version: r.contentVersion,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(out) }],
        structuredContent: out,
      };
    },
  );

  // ---- files_mkdir ----------------------------------------------------------

  server.registerTool(
    "files_mkdir",
    {
      title: "Create directory",
      description:
        "Create a directory at the given path, creating missing parent directories. " +
        "Fails with `conflict` if the path already exists.",
      inputSchema: {
        path: z
          .string()
          .describe("Absolute directory path, e.g. `/notes/2026-04`."),
      },
      outputSchema: { path: z.string() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path }) => {
      const r = await fileService.mkdir(auth, path);
      if (!r.ok) {
        return errorResult(
          normalizeFsCode(r.code as FsErrorCode),
          `failed to mkdir ${path}`,
        );
      }
      const out = { path };
      return {
        content: [{ type: "text", text: JSON.stringify(out) }],
        structuredContent: out,
      };
    },
  );

  // ---- files_move -----------------------------------------------------------

  server.registerTool(
    "files_move",
    {
      title: "Move or rename",
      description:
        "Rename or move a file or directory. Both `from` and `to` are absolute paths. " +
        "Fails with `conflict` if `to` already exists. " +
        "Moving a directory moves all its contents.",
      inputSchema: {
        from: z.string().describe("Source absolute path (must exist)."),
        to: z
          .string()
          .describe(
            "Destination absolute path. Parent directory must exist; the destination itself must not exist.",
          ),
      },
      outputSchema: { from: z.string(), to: z.string() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ from, to }) => {
      const r = await fileService.moveFile(auth, from, to);
      if (!r.ok) {
        const code: ErrorCode =
          r.code === "invalid_source_path" || r.code === "invalid_dest_path"
            ? "invalid_path"
            : r.code === "forbidden"
              ? "out_of_scope"
              : r.code === "cycle"
                ? "conflict"
                : r.code;
        return errorResult(code, `failed to move ${from} -> ${to}`);
      }
      const out = { from, to };
      return {
        content: [{ type: "text", text: JSON.stringify(out) }],
        structuredContent: out,
      };
    },
  );

  // ---- files_delete ---------------------------------------------------------

  server.registerTool(
    "files_delete",
    {
      title: "Delete (move to trash)",
      description:
        "Soft-delete a file or directory by moving it to trash. " +
        "Deletes are recoverable from trash for a limited time. " +
        "Deleting a directory deletes all its contents.",
      inputSchema: {
        path: z.string().describe("Absolute path to delete."),
      },
      outputSchema: { path: z.string() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path }) => {
      const r = await fileService.deleteFile(auth, path);
      if (!r.ok) {
        return errorResult(
          normalizeFsCode(r.code as FsErrorCode),
          `failed to delete ${path}`,
        );
      }
      const out = { path };
      return {
        content: [{ type: "text", text: JSON.stringify(out) }],
        structuredContent: out,
      };
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP entrypoint
// ---------------------------------------------------------------------------

async function handle(
  request: Request,
  context: ActionFunctionArgs["context"],
): Promise<Response> {
  const env = getRuntimeEnv(context);
  const auth = await getTokenAuthContext(request, env);
  const expectedResource = canonicalResource(request);
  if (!assertAudience(auth, expectedResource)) return unauthorized(request);

  const { fileService } = createServices(getAppContext(context), auth.user_id);
  const server = buildServer(fileService, auth);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });

  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await transport.close().catch(() => {});
  }
}

export async function loader(_args: LoaderFunctionArgs) {
  // GET = SSE upgrade. stateless, so respond 405.
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  });
}

export async function action({ request, context }: ActionFunctionArgs) {
  return handle(request, context);
}
