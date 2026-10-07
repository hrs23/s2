import { describe, expect, it } from "vitest";
import { evaluateEdge } from "./middleware";

// middleware behaviour:
//   - /internal/*  Bearer rejected at the edge (defence-in-depth on the
//                   cookie-only WebUI surface).
//   - CSRF guard   cookie-authed unsafe methods on any URL prefix must come
//                   from the app's origin. Bearer-authed requests are exempt
//                   (no auto-attached cookie); /api/auth/* runs Better Auth's
//                   built-in Origin check.
//
// Drives the production `evaluateEdge` directly with a hand-rolled
// Request-like shape so the test cannot drift from the server entrypoint.
// We avoid `new Request(...)` because some test envs (happy-dom / undici)
// strip the forbidden `Cookie` header on Request construction, which would
// silently turn cookie-bearing CSRF cases into anonymous ones.

interface MiniReq {
  pathname: string;
  method: string;
  headers: Record<string, string>;
}

function buildRequest(req: MiniReq): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) headers.set(k, v);
  return {
    method: req.method,
    headers,
  } as unknown as Request;
}

function shouldReject(req: MiniReq, appUrl: string | null): number | null {
  const r = buildRequest(req);
  const res = evaluateEdge(r, req.pathname, appUrl ?? "");
  return res ? res.status : null;
}

const APP = "https://app.example";
const SESSION_COOKIE = "better-auth.session_token=abc";

describe("edge middleware", () => {
  it("__Secure- prefixed session cookie triggers CSRF origin check", () => {
    const base = {
      pathname: "/api/files/mkdir",
      method: "POST",
      headers: { Cookie: "a=b; __Secure-better-auth.session_token=abc" },
    };
    expect(shouldReject(base, APP)).toBe(403);
    expect(
      shouldReject({ ...base, headers: { ...base.headers, Origin: APP } }, APP),
    ).toBeNull();
  });

  it("cookie name with a different character in place of the dot is not a session cookie", () => {
    expect(
      shouldReject(
        {
          pathname: "/api/files/mkdir",
          method: "POST",
          headers: { Cookie: "better-authXsession_token=abc" },
        },
        APP,
      ),
    ).toBeNull();
  });

  it("/internal/* rejects Bearer (403)", () => {
    expect(
      shouldReject(
        {
          pathname: "/internal/account",
          method: "GET",
          headers: { Authorization: "Bearer s2_abc" },
        },
        APP,
      ),
    ).toBe(403);
  });

  it("/internal/* allows cookie GET", () => {
    expect(
      shouldReject(
        {
          pathname: "/internal/account",
          method: "GET",
          headers: { Cookie: SESSION_COOKIE },
        },
        APP,
      ),
    ).toBeNull();
  });

  it("/internal/* unsafe method requires same-origin Origin", () => {
    expect(
      shouldReject(
        {
          pathname: "/internal/tokens",
          method: "POST",
          headers: { Cookie: SESSION_COOKIE },
        },
        APP,
      ),
    ).toBe(403);
    expect(
      shouldReject(
        {
          pathname: "/internal/tokens",
          method: "POST",
          headers: { Cookie: SESSION_COOKIE, Origin: "https://evil.example" },
        },
        APP,
      ),
    ).toBe(403);
    expect(
      shouldReject(
        {
          pathname: "/internal/tokens",
          method: "POST",
          headers: { Cookie: SESSION_COOKIE, Origin: APP },
        },
        APP,
      ),
    ).toBeNull();
  });

  it("/api/v1/* with Bearer is exempt from Origin check (no cookie)", () => {
    expect(
      shouldReject(
        {
          pathname: "/api/v1/files/x",
          method: "PUT",
          headers: { Authorization: "Bearer s2_abc" },
        },
        APP,
      ),
    ).toBeNull();
  });

  it("/api/v1/* cookie-authed unsafe method requires same-origin", () => {
    expect(
      shouldReject(
        {
          pathname: "/api/v1/files/x",
          method: "PUT",
          headers: { Cookie: SESSION_COOKIE },
        },
        APP,
      ),
    ).toBe(403);
    expect(
      shouldReject(
        {
          pathname: "/api/v1/files/x",
          method: "PUT",
          headers: { Cookie: SESSION_COOKIE, Origin: APP },
        },
        APP,
      ),
    ).toBeNull();
  });

  it("APP_URL missing/malformed => CSRF fails closed (403)", () => {
    expect(
      shouldReject(
        {
          pathname: "/internal/tokens",
          method: "POST",
          headers: { Cookie: SESSION_COOKIE, Origin: APP },
        },
        null,
      ),
    ).toBe(403);
    expect(
      shouldReject(
        {
          pathname: "/internal/tokens",
          method: "POST",
          headers: { Cookie: SESSION_COOKIE, Origin: APP },
        },
        "not-a-url",
      ),
    ).toBe(403);
  });

  it("/api/auth/* exempt from CSRF check (Better Auth handles it)", () => {
    expect(
      shouldReject(
        {
          pathname: "/api/auth/sign-in/email",
          method: "POST",
          headers: { Cookie: SESSION_COOKIE },
        },
        APP,
      ),
    ).toBeNull();
  });

  it("anonymous unsafe POST (no cookie, no Bearer) is allowed at the middleware level", () => {
    // Authentication is enforced by the handler's getAuthContext, not middleware.
    expect(
      shouldReject(
        { pathname: "/api/v1/files/x", method: "PUT", headers: {} },
        APP,
      ),
    ).toBeNull();
  });

  it("non-prefixed routes are not affected", () => {
    expect(
      shouldReject(
        {
          pathname: "/dav/file.txt",
          method: "GET",
          headers: { Authorization: "Basic xx" },
        },
        APP,
      ),
    ).toBeNull();
    expect(
      shouldReject({ pathname: "/", method: "GET", headers: {} }, APP),
    ).toBeNull();
  });
});
