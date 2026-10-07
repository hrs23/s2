// Security headers for raw file content served from the app origin.
//
// A user (or any scoped write token) can store arbitrary bytes under an
// arbitrary Content-Type. Without these headers the browser would render
// `text/html` / `image/svg+xml` as an active document on the app origin when
// the URL is opened top-level — a stored-XSS path to full account takeover
// (the script runs with the victim's session, reaching /internal/* and every
// out-of-scope file). See the file-serving routes (api.files.$, api.revisions,
// app/lib/gateway/dav) for the call sites.
//
// Defense is default-deny: only an allowlist of inline-safe media types (the
// ones the in-app preview actually renders) keep `inline`; everything else is
// forced to `attachment` so it downloads instead of executing. `nosniff` is
// always set so a type-confusion upload (HTML bytes labeled `image/png`) can't
// be sniffed back into an active document.

/**
 * Base MIME types safe to render inline. Mirrors the preview viewers in
 * app/components/files/file-preview.tsx (image / video / audio / pdf). SVG and
 * HTML are intentionally excluded — they can carry script.
 */
const INLINE_SAFE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
  "application/pdf",
]);

/** Strip parameters (`; charset=...`) and normalize for allowlist lookup. */
function baseType(contentType: string): string {
  return contentType.split(";", 1)[0].trim().toLowerCase();
}

/**
 * Apply security headers to a file-content response. Always sets
 * `X-Content-Type-Options: nosniff`; sets `Content-Disposition` to `inline`
 * for inline-safe types and `attachment` for everything else.
 *
 * Mutates and returns the passed `Headers` for convenient chaining.
 */
export function applyDownloadSecurityHeaders(
  headers: Headers,
  contentType: string,
): Headers {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set(
    "Content-Disposition",
    INLINE_SAFE_TYPES.has(baseType(contentType)) ? "inline" : "attachment",
  );
  return headers;
}
