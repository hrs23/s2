// Unit tests for parseAllowedResources (RFC 8707 audience allowlist).

import { describe, expect, it } from "vitest";
import { parseAllowedResources } from "./oauth-service.server";

describe("parseAllowedResources", () => {
  it("returns localhost defaults when env var is undefined", () => {
    const set = parseAllowedResources(undefined);
    expect(set.has("http://localhost:8787/mcp")).toBe(true);
    expect(set.has("http://localhost/mcp")).toBe(true);
  });

  it("returns localhost defaults when env var is empty string", () => {
    const set = parseAllowedResources("");
    expect(set.has("http://localhost:8787/mcp")).toBe(true);
  });

  it("parses a single canonical URI", () => {
    const set = parseAllowedResources("https://s2.example.com/mcp");
    expect([...set]).toEqual(["https://s2.example.com/mcp"]);
  });

  it("parses comma-separated entries with surrounding whitespace", () => {
    const set = parseAllowedResources(
      "https://s2.example.com/mcp , https://preview.s2.example.com/mcp",
    );
    expect(set.has("https://s2.example.com/mcp")).toBe(true);
    expect(set.has("https://preview.s2.example.com/mcp")).toBe(true);
  });

  it("normalizes entries (lowercase host, strip trailing slash, default port)", () => {
    const set = parseAllowedResources(
      "HTTPS://S2.EXAMPLE.COM/mcp/,https://example.com:443/mcp",
    );
    expect(set.has("https://s2.example.com/mcp")).toBe(true);
    expect(set.has("https://example.com/mcp")).toBe(true);
  });

  it("rejects empty entries (defense against stray commas)", () => {
    // Strict parsing — misconfigurations fail loud.
    expect(() =>
      parseAllowedResources("https://s2.example.com/mcp,,https://x/mcp"),
    ).toThrow(/empty entry/);
    expect(() => parseAllowedResources("https://s2.example.com/mcp,")).toThrow(
      /empty entry/,
    );
  });

  it("deduplicates equivalent entries after normalization", () => {
    const set = parseAllowedResources(
      "https://s2.example.com/mcp,https://S2.EXAMPLE.COM/mcp/",
    );
    expect(set.size).toBe(1);
  });
});
