// Unit tests for canonical resource normalization (RFC 8707).

import { describe, expect, it } from "vitest";
import { canonicalResource, normalizeResource } from "./canonical-resource";

describe("normalizeResource", () => {
  it("strips trailing slash on path", () => {
    expect(normalizeResource("https://s2.example.com/mcp/")).toBe(
      "https://s2.example.com/mcp",
    );
  });

  it("preserves non-default port", () => {
    expect(normalizeResource("http://localhost:8787/mcp")).toBe(
      "http://localhost:8787/mcp",
    );
  });

  it("strips default port (URL spec)", () => {
    expect(normalizeResource("https://s2.example.com:443/mcp")).toBe(
      "https://s2.example.com/mcp",
    );
    expect(normalizeResource("http://example.com:80/mcp")).toBe(
      "http://example.com/mcp",
    );
  });

  it("lowercases host", () => {
    expect(normalizeResource("https://S2.EXAMPLE.COM/mcp")).toBe(
      "https://s2.example.com/mcp",
    );
  });

  it("lowercases scheme", () => {
    expect(normalizeResource("HTTPS://s2.example.com/mcp")).toBe(
      "https://s2.example.com/mcp",
    );
  });

  it("drops query and fragment", () => {
    expect(normalizeResource("https://s2.example.com/mcp?x=1#frag")).toBe(
      "https://s2.example.com/mcp",
    );
  });

  it("preserves root path as-is (no trailing slash trim on `/`)", () => {
    expect(normalizeResource("https://s2.example.com/")).toBe(
      "https://s2.example.com/",
    );
  });

  it("returns input unchanged when not a valid URL", () => {
    expect(normalizeResource("not-a-url")).toBe("not-a-url");
    expect(normalizeResource("  not-a-url  ")).toBe("not-a-url");
  });

  it("normalizes the same allowlist entry and a presented value identically", () => {
    // The whole point: equal after normalization, even if their on-wire forms differ.
    const a = normalizeResource("https://S2.EXAMPLE.COM/mcp/");
    const b = normalizeResource("https://s2.example.com/mcp");
    expect(a).toBe(b);
  });
});

describe("canonicalResource", () => {
  it("builds `<scheme>://<host>/mcp` from the request URL", () => {
    const req = new Request("http://localhost:8787/mcp", { method: "POST" });
    expect(canonicalResource(req)).toBe("http://localhost:8787/mcp");
  });

  it("ignores path beyond /mcp", () => {
    const req = new Request("http://localhost/mcp/foo/bar", { method: "POST" });
    expect(canonicalResource(req)).toBe("http://localhost/mcp");
  });

  it("matches the value used to enforce audience", () => {
    // The /.well-known/oauth-protected-resource handler produces a string
    // shaped like `${origin}/mcp`. After normalization, that equals what
    // canonicalResource returns for the same origin — keeping discovery,
    // issuance, and verification in lockstep.
    const req = new Request("https://S2.EXAMPLE.COM/mcp", { method: "POST" });
    expect(canonicalResource(req)).toBe(
      normalizeResource("https://s2.example.com/mcp"),
    );
  });
});
