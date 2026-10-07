/**
 * Normalize by appending a trailing slash. /notes -> /notes/
 * @internal Shared within paths/scope modules. Not part of the public contract.
 */
export function normalizePath(p: string): string {
  return p.endsWith("/") ? p : `${p}/`;
}

/** Check if child is under (or equal to) parent */
export function pathIsUnder(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  return c.startsWith(p);
}

/** Join base path and access path for display, returning structured parts.
 *  By contract: basePath is absolute (leading "/"), accessPath is
 *  basePath-relative (no leading "/"); root is "". The helper still tolerates
 *  a leading-slash on accessPath so display callers do not crash on legacy
 *  data during migration. full never contains double slashes. */
export function joinPaths(
  basePath: string,
  accessPath: string,
): { base: string; suffix: string; full: string } {
  // Normalize base: "/" -> "/", "/photos" -> "/photos/"
  const base = basePath === "/" ? "/" : basePath.replace(/\/?$/, "/");
  // Normalize access: "", "/" -> root (everything under base). The "/"
  // alias is for legacy data only; new contract is "".
  const isRoot = accessPath === "" || accessPath === "/";
  const suffix = isRoot ? "" : accessPath.replace(/^\//, "");
  // Full path: base + suffix, collapse any double slashes
  const full = (base + suffix).replace(/\/\/+/g, "/");
  return { base: base === "/" ? "" : base, suffix, full };
}

/**
 * Validate a raw client path for safety (traversal attempts, null bytes).
 * Returns an error message or null if safe.
 *
 * Use this when you only need yes/no validation (UI input checks). For Service-side
 * path operations, call parseClientPath instead — it runs this internally.
 */
export function validateClientPath(rawPath: string): string | null {
  const clean = rawPath.replace(/^\/+/, "");
  return validatePathTraversal(clean);
}

/** File-local. Exported callers must use validateClientPath or parseClientPath instead. */
function validatePathTraversal(value: string): string | null {
  if (value.includes("\0")) return "Path must not contain null bytes";
  const segments = value.split("/");
  for (const seg of segments) {
    if (seg === "..") return "Path must not contain '..'";
  }
  return null;
}

/**
 * Validate a base_path value (absolute path; leading "/" required).
 * Returns error message or null if valid.
 */
export function validateBasePath(value: string): string | null {
  if (typeof value !== "string") return "Base Path must be a string";
  if (!value.startsWith("/")) return "Base Path must start with /";
  if (value !== "/" && value.endsWith("/"))
    return "Base Path must not end with /";
  if (value.includes("//")) return "Base Path must not contain //";
  if (value.includes("\0")) return "Base Path must not contain NUL bytes";
  if (/[\r\n]/.test(value)) return "Base Path must not contain newlines";
  if (value !== value.trim())
    return "Base Path must not have leading/trailing whitespace";
  for (const seg of value.split("/").filter(Boolean)) {
    if (seg === "..") return "Base Path must not contain ..";
    if (seg === ".") return "Base Path must not contain .";
  }
  return null;
}

/**
 * Validate an access_paths[].path value (basePath-relative).
 *
 *   ""           — root of base_path (the entire scope)
 *   "photos"     — base_path/photos
 *   "photos/raw" — base_path/photos/raw
 *
 * Rejects leading "/", trailing "/", "//", "." / ".." segments, NUL bytes,
 * newlines, and leading/trailing whitespace. DB CHECK chk_grant_paths_path
 * enforces the same rule as the last line of defense.
 */
export function validateAccessPath(value: string): string | null {
  if (typeof value !== "string") return "Access path must be a string";
  if (value === "") return null; // canonical root
  if (value.startsWith("/"))
    return "Access path must be relative (no leading /)";
  // A trailing "/" is stripped by canonicalizeAccessPath at the boundary, so
  // tolerate it here. Internal "//" is ambiguous (empty segment) — reject.
  const stripped = value.endsWith("/") ? value.slice(0, -1) : value;
  if (stripped.includes("//"))
    return "Access path must not contain empty segments (//)";
  if (stripped.includes("\0")) return "Access path must not contain NUL bytes";
  if (/[\r\n]/.test(stripped)) return "Access path must not contain newlines";
  if (stripped !== stripped.trim())
    return "Access path must not have leading/trailing whitespace";
  for (const seg of stripped.split("/")) {
    if (seg === "..") return "Access path must not contain ..";
    if (seg === ".") return "Access path must not contain .";
  }
  return null;
}

/**
 * Canonicalize a base-path-relative access path. Strips a trailing
 * "/" and maps the legacy absolute-root token "/" to "" for backward
 * tolerance, but does NOT auto-strip a leading "/" — that is a validation
 * concern (callers should `validateAccessPath` before storing).
 */
export function canonicalizeAccessPath(p: string): string {
  if (p === "" || p === "/") return "";
  return p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * Validate, canonicalize and de-duplicate a list of access_paths entries.
 * Checks run per entry in order: path syntax, (optional) access level, then
 * duplicate detection on the canonical path. Entries without `access` default
 * to "write". Callers map `error` to their own result type.
 */
export function canonicalizeAccessPaths(
  entries: ReadonlyArray<{ path: string; access?: string }>,
  opts: {
    /** Reject `access` values other than "read" / "write" (when defined). */
    checkAccess?: boolean;
    duplicateMessage: (canonical: string) => string;
  },
):
  | { ok: true; paths: Array<{ path: string; access: "read" | "write" }> }
  | { ok: false; error: string } {
  const seen = new Set<string>();
  const paths: Array<{ path: string; access: "read" | "write" }> = [];
  for (const p of entries) {
    const pathErr = validateAccessPath(p.path);
    if (pathErr) return { ok: false, error: pathErr };
    if (
      opts.checkAccess &&
      p.access !== undefined &&
      p.access !== "read" &&
      p.access !== "write"
    ) {
      return {
        ok: false,
        error: `access_paths[].access must be "read" or "write", got "${p.access}"`,
      };
    }
    const canonical = canonicalizeAccessPath(p.path);
    if (seen.has(canonical)) {
      return { ok: false, error: opts.duplicateMessage(canonical) };
    }
    seen.add(canonical);
    paths.push({
      path: canonical,
      access: (p.access as "read" | "write" | undefined) ?? "write",
    });
  }
  return { ok: true, paths };
}

/** Strip all leading "/" from a raw client path. */
export function stripLeadingSlashes(p: string): string {
  return p.replace(/^\/+/, "");
}

/** True when `p` is a string with at least one non-slash-prefix character. */
export function isNonEmptyPath(p: unknown): p is string {
  return typeof p === "string" && stripLeadingSlashes(p) !== "";
}

/** Resolve a root path and relative path into an absolute path.
 *  Used by token delegation scope validation. */
export function resolvePath(root: string, relativePath: string): string {
  const r = root.endsWith("/") ? root : `${root}/`;
  const p = relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;
  return r + p;
}

/**
 * Split a path string into segments, filtering empty parts and NFC-normalizing.
 * "/docs/project/report.pdf" → ["docs", "project", "report.pdf"]
 */
export function splitPath(path: string): string[] {
  return path
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => s.normalize("NFC"));
}

// ---------------------------------------------------------------------------
// rawPath → absolute segments → client path conversion
// ---------------------------------------------------------------------------

/**
 * Validate, split, and convert a raw client path string to absolute segments.
 * Single entry point for all path inputs in FileService / UploadService.
 *
 * Returns { ok: true, segments } or { ok: false, error } (use for 400 responses).
 */
export function parseClientPath(
  rawPath: string,
  auth: { type: string; base_path?: string },
): { ok: true; segments: string[] } | { ok: false; error: string } {
  const pathError = validateClientPath(rawPath);
  if (pathError) return { ok: false, error: pathError };
  const clean = rawPath.replace(/^\/+/, "");
  const basePath =
    auth.type === "token" && auth.base_path ? auth.base_path : "/";
  return {
    ok: true,
    segments: clientSegmentsToAbsolute(basePath, splitPath(clean)),
  };
}

/**
 * Convert client segments (relative to base_path) to absolute segments.
 * For base_path="/agents/", clientSegments=["foo","bar"] → ["agents","foo","bar"].
 * For base_path="/", returns clientSegments unchanged.
 */
function clientSegmentsToAbsolute(
  basePath: string,
  clientSegments: string[],
): string[] {
  const baseSegments = basePath.split("/").filter(Boolean);
  return [...baseSegments, ...clientSegments];
}

/**
 * Convert an absolute path back to a client path relative to base_path.
 * For base_path="/agents/", absolutePath="/agents/foo/bar" → "/foo/bar".
 * For base_path="/", returns absolutePath unchanged.
 * Returns null if absolutePath is not under base_path.
 */
export function absolutePathToClient(
  basePath: string,
  absolutePath: string,
): string | null {
  if (basePath === "/") return absolutePath;
  const normalized = basePath.endsWith("/") ? basePath : `${basePath}/`;
  if (absolutePath === normalized.slice(0, -1)) return "/"; // exact match: base itself
  if (!absolutePath.startsWith(normalized)) return null;
  return absolutePath.slice(normalized.length - 1); // keep leading /
}
