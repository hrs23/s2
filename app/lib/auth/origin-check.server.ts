// Same-origin guard for state-changing requests.
//
// Browsers always attach an `Origin` header to cross-origin form POSTs, so we
// reject anything whose Origin doesn't match APP_URL. This closes the
// "login CSRF" variant that SameSite=Lax does not cover: SameSite governs
// whether *cookies are sent*, not whether a cross-site POST can *receive*
// `Set-Cookie`. Without this check, a malicious page could auto-submit a
// forged /login/verify form and pin the victim's browser to an
// attacker-owned account (OWASP CSRF).

export interface OriginCheckResult {
  ok: boolean;
  reason?: "missing" | "mismatch";
}

export function checkSameOrigin(
  request: Request,
  appUrl: string,
): OriginCheckResult {
  const origin = request.headers.get("Origin");
  if (!origin) return { ok: false, reason: "missing" };
  let expected: string;
  try {
    expected = new URL(appUrl).origin;
  } catch {
    return { ok: false, reason: "mismatch" };
  }
  return origin === expected ? { ok: true } : { ok: false, reason: "mismatch" };
}
