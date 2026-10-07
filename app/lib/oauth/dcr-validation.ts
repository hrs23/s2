// DCR (RFC 7591) abuse-control validation.
//
// Pure functions only — no I/O, no DB. Callable from both server-side
// validation and unit tests. Error messages follow RFC 7591 §3.2.2 wording.

// "s2" is intentionally excluded: it is short and ambiguous. Brand protection
// is out of scope for OAuth; an operator deletes offenders from `oauth_clients`.
const RESERVED_NAME_TOKENS = [
  "official",
  "verified",
  "admin",
  "system",
] as const;

// whole-word match: token must NOT be flanked by [a-z0-9] on either side.
// "Official Sync" / "the OFFICIAL app" → match.  "Officially" → no match.
const RESERVED_NAME_RE = new RegExp(
  `(?<![a-z0-9])(${RESERVED_NAME_TOKENS.join("|")})(?![a-z0-9])`,
  "i",
);

const CLIENT_NAME_MAX_LEN = 80;

// C0 (U+0000-U+001F) and C1 (U+007F-U+009F) control characters. Detected
// via charCodeAt rather than a regex literal because biome's
// noControlCharactersInRegex forbids inlined control-char ranges.
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/**
 * Validate `client_name` (abuse controls):
 * - length 1-80 (after trimming)
 * - no C0 / C1 control characters
 * - no reserved tokens (case-insensitive whole-word match)
 *
 * Returns null on success or a human-readable reason string on failure.
 */
export function validateClientName(clientName: unknown): string | null {
  if (typeof clientName !== "string") {
    return "client_name must be a string";
  }
  const trimmed = clientName.trim();
  if (trimmed.length === 0) {
    return "client_name must not be empty";
  }
  if (trimmed.length > CLIENT_NAME_MAX_LEN) {
    return `client_name must be ${CLIENT_NAME_MAX_LEN} characters or fewer`;
  }
  if (hasControlChar(trimmed)) {
    return "client_name must not contain control characters";
  }
  const match = RESERVED_NAME_RE.exec(trimmed);
  if (match) {
    return `client_name must not contain reserved word "${match[1].toLowerCase()}"`;
  }
  return null;
}

/**
 * Validate a single redirect_uri against the abuse-control allowlist:
 * - http://127.0.0.1 or http://localhost (any port, any path)
 * - https://...  (any host)
 * Everything else (custom schemes, javascript:, data:, http to non-loopback)
 * is rejected.
 *
 * Also enforces RFC 7591 §2: no fragment in redirect_uri.
 *
 * Returns null on success or a human-readable reason string on failure.
 */
export function validateDcrRedirectUri(uri: unknown): string | null {
  if (typeof uri !== "string" || uri.length === 0) {
    return "redirect_uri must be a non-empty string";
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return `redirect_uri is not a valid URL: ${uri}`;
  }
  if (parsed.hash !== "") {
    return "redirect_uri must not contain fragment";
  }
  if (parsed.protocol === "https:") {
    return null;
  }
  if (parsed.protocol === "http:") {
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      return null;
    }
    return `redirect_uri http:// is only allowed for loopback (got ${parsed.hostname})`;
  }
  return `redirect_uri scheme "${parsed.protocol.replace(/:$/, "")}" is not allowed`;
}
