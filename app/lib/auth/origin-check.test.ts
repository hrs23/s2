import { describe, expect, it } from "vitest";
import { checkSameOrigin } from "./origin-check.server";

const APP = "http://localhost:8888";

// `Origin` is a "forbidden request-header" and the Fetch spec — including
// Node's undici — silently strips it from user-constructed Request objects.
// The browser injects it for us at the real network boundary, so to exercise
// checkSameOrigin's logic directly we hand-roll a minimal Request-shaped
// object exposing only the `.headers.get` surface the helper uses.
function req(headers: Record<string, string>): Request {
  const store = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    headers: {
      get(name: string) {
        return store.get(name.toLowerCase()) ?? null;
      },
    },
  } as unknown as Request;
}

describe("checkSameOrigin", () => {
  it("accepts the configured origin", () => {
    expect(checkSameOrigin(req({ Origin: APP }), APP)).toEqual({ ok: true });
  });

  it("rejects a cross-origin Origin header", () => {
    expect(
      checkSameOrigin(req({ Origin: "https://evil.example" }), APP),
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects requests without an Origin header", () => {
    expect(checkSameOrigin(req({}), APP)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("rejects requests that look like an origin but point at a different host", () => {
    expect(
      checkSameOrigin(req({ Origin: "http://localhost:9999" }), APP),
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects when appUrl is unparseable", () => {
    expect(checkSameOrigin(req({ Origin: APP }), "not-a-url")).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });
});
