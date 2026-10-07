import { describe, expect, it } from "vitest";
import {
  checkIfMatch,
  checkIfNoneMatch,
  formatETag,
  parseETag,
} from "./etag.server";

describe("parseETag", () => {
  it("parses quoted integer", () => {
    expect(parseETag('"42"')).toBe(42);
  });

  it("parses zero", () => {
    expect(parseETag('"0"')).toBe(0);
  });

  it("returns null for null input", () => {
    expect(parseETag(null)).toBeNull();
  });

  it("returns null for unquoted value", () => {
    expect(parseETag("42")).toBeNull();
  });

  it("returns null for non-integer", () => {
    expect(parseETag('"abc"')).toBeNull();
  });

  it("returns null for weak etag", () => {
    expect(parseETag('W/"42"')).toBeNull();
  });
});

describe("formatETag", () => {
  it("formats as quoted string", () => {
    expect(formatETag(42)).toBe('"42"');
  });

  it("formats zero", () => {
    expect(formatETag(0)).toBe('"0"');
  });
});

describe("checkIfMatch", () => {
  const req = (header: string | null) => {
    const headers = new Headers();
    if (header) headers.set("If-Match", header);
    return new Request("http://localhost/test", { headers });
  };

  it("returns null when no header", () => {
    expect(checkIfMatch(req(null), 42)).toBeNull();
  });

  it("returns true when wildcard", () => {
    expect(checkIfMatch(req("*"), 42)).toBe(true);
  });

  it("returns true when version matches", () => {
    expect(checkIfMatch(req('"42"'), 42)).toBe(true);
  });

  it("returns false when version does not match", () => {
    expect(checkIfMatch(req('"41"'), 42)).toBe(false);
  });

  it("returns false for malformed header", () => {
    expect(checkIfMatch(req("invalid"), 42)).toBe(false);
  });
});

describe("checkIfNoneMatch", () => {
  const req = (header: string | null) => {
    const headers = new Headers();
    if (header) headers.set("If-None-Match", header);
    return new Request("http://localhost/test", { headers });
  };

  it("returns false when no header", () => {
    expect(checkIfNoneMatch(req(null), 42)).toBe(false);
  });

  it("returns true when wildcard and resource exists", () => {
    expect(checkIfNoneMatch(req("*"), 42)).toBe(true);
  });

  it("returns false when wildcard and resource does not exist", () => {
    expect(checkIfNoneMatch(req("*"), null)).toBe(false);
  });

  it("returns true when version matches (not modified)", () => {
    expect(checkIfNoneMatch(req('"42"'), 42)).toBe(true);
  });

  it("returns false when version does not match (modified)", () => {
    expect(checkIfNoneMatch(req('"41"'), 42)).toBe(false);
  });

  it("returns false when resource does not exist", () => {
    expect(checkIfNoneMatch(req('"42"'), null)).toBe(false);
  });
});
