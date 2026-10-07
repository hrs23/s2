// Post-login redirect ("returnTo") helper.
//
// Why a cookie:
//   An unauthenticated user bounced from /oauth/authorize to /login must be
//   able to return to the consent screen after login. Password sign-in stays
//   same-origin, but Google / GitHub sign-in leaves for an external IdP, so the
//   URL cannot carry it. A single HttpOnly cookie covers every path (password /
//   Google / GitHub): set in one place, read in two.
//
// Future: if the whole AuthZ request moves server-side keyed by a
//   flow_id, this cookie shrinks to one opaque ID. Rework cost is small, so
//   this is the minimal implementation for now.
//
// Security: to prevent open redirects, the target must be a same-origin
//   relative path only. Must start with "/", must not start with "//" or "\\",
//   no absolute URLs, and a length cap applies.

const COOKIE_NAME = "auth_return_to";
const TTL_SECONDS = 600;
const MAX_LENGTH = 2048;

export function validateReturnTo(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  if (value.length > MAX_LENGTH) return null;
  // Relative paths only. "//" and "/\\" are treated as protocol-relative URLs, so reject them.
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  if (value.includes("\\")) return null;
  // Reject control characters (newline / NUL etc.) — prevents Set-Cookie / Location header injection.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are rejected explicitly.
  if (/[\x00-\x1f\x7f]/.test(value)) return null;
  return value;
}

export function setReturnToCookie(value: string): string {
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${TTL_SECONDS}`;
}

export function readReturnToCookie(cookieHeader: string): string | null {
  const re = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`);
  const match = cookieHeader.match(re);
  if (!match) return null;
  try {
    return validateReturnTo(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}
