// ETag middleware: shared conditional-request logic for all API surfaces.

/**
 * Parse an ETag header value into a content_version number.
 * ETag format: "42" (quoted integer string).
 * Returns null if the header is missing, malformed, or wildcard (*).
 */
export function parseETag(header: string | null): number | null {
  if (!header) return null;
  const match = header.match(/^"(\d+)"$/);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

/**
 * Check If-Match precondition (RFC 9110 §13.1.1).
 * Used on PUT/DELETE to detect concurrent writes.
 *
 * Returns:
 * - null if no If-Match header (allow request to proceed)
 * - true if ETag matches
 * - false if ETag does not match → caller should return 412
 */
export function checkIfMatch(
  request: Request,
  currentVersion: number,
): boolean | null {
  const header = request.headers.get("If-Match");
  if (!header) return null;

  // Wildcard: matches any existing resource
  if (header.trim() === "*") return true;

  const version = parseETag(header);
  if (version === null) return false;
  return version === currentVersion;
}

/**
 * Check If-None-Match precondition (RFC 9110 §13.1.2).
 *
 * For GET/HEAD: returns true if resource has NOT changed (→ 304).
 * For PUT/MKCOL with "*": returns true if resource EXISTS (→ 412).
 */
export function checkIfNoneMatch(
  request: Request,
  currentVersion: number | null,
): boolean {
  const header = request.headers.get("If-None-Match");
  if (!header) return false;

  // Wildcard on write methods: "create only if absent"
  if (header.trim() === "*") {
    return currentVersion !== null;
  }

  if (currentVersion === null) return false;
  const version = parseETag(header);
  if (version === null) return false;
  return version === currentVersion;
}

/** Format a content_version as an ETag header value. */
export function formatETag(contentVersion: number): string {
  return `"${contentVersion}"`;
}
