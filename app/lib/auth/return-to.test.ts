import { describe, expect, it } from "vitest";
import {
  readReturnToCookie,
  setReturnToCookie,
  validateReturnTo,
} from "./return-to";

describe("validateReturnTo", () => {
  it("accepts same-origin absolute paths", () => {
    expect(validateReturnTo("/oauth/authorize?client_id=x&scope=y")).toBe(
      "/oauth/authorize?client_id=x&scope=y",
    );
    expect(validateReturnTo("/")).toBe("/");
    expect(validateReturnTo("/dashboard")).toBe("/dashboard");
  });

  it("rejects null / empty / undefined", () => {
    expect(validateReturnTo(null)).toBeNull();
    expect(validateReturnTo(undefined)).toBeNull();
    expect(validateReturnTo("")).toBeNull();
  });

  it("rejects absolute URLs (open redirect)", () => {
    expect(validateReturnTo("https://evil.example/x")).toBeNull();
    expect(validateReturnTo("http://evil.example")).toBeNull();
    expect(validateReturnTo("javascript:alert(1)")).toBeNull();
  });

  it("rejects protocol-relative URLs", () => {
    expect(validateReturnTo("//evil.example/x")).toBeNull();
    expect(validateReturnTo("/\\evil.example")).toBeNull();
  });

  it("rejects backslashes (Windows path / parser bypass)", () => {
    expect(validateReturnTo("/foo\\bar")).toBeNull();
  });

  it("rejects control characters (header injection)", () => {
    expect(validateReturnTo("/foo\nLocation: https://evil")).toBeNull();
    expect(validateReturnTo("/foo\r\n")).toBeNull();
    expect(validateReturnTo("/foo\x00")).toBeNull();
  });

  it("rejects relative paths without leading slash", () => {
    expect(validateReturnTo("dashboard")).toBeNull();
    expect(validateReturnTo("../admin")).toBeNull();
  });

  it("rejects values exceeding the length cap", () => {
    expect(validateReturnTo(`/${"a".repeat(2048)}`)).toBeNull();
  });
});

describe("setReturnToCookie", () => {
  it("encodes value and sets HttpOnly Secure SameSite=Lax flags", () => {
    const cookie = setReturnToCookie("/oauth/authorize?x=1&y=2");
    expect(cookie).toContain(
      "auth_return_to=%2Foauth%2Fauthorize%3Fx%3D1%26y%3D2",
    );
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=600");
  });
});

describe("readReturnToCookie", () => {
  it("reads and validates a previously-set cookie", () => {
    const set = setReturnToCookie("/oauth/authorize?x=1");
    // Set-Cookie header is "name=value; flags..."; the browser sends back just
    // the name=value pair as the Cookie request header.
    const pair = set.split(";")[0];
    expect(readReturnToCookie(pair)).toBe("/oauth/authorize?x=1");
  });

  it("returns null when cookie is missing", () => {
    expect(readReturnToCookie("")).toBeNull();
    expect(readReturnToCookie("other=cookie")).toBeNull();
  });

  it("returns null when stored value fails validation (tampered)", () => {
    expect(readReturnToCookie("auth_return_to=https%3A%2F%2Fevil")).toBeNull();
    expect(readReturnToCookie("auth_return_to=%2F%2Fevil")).toBeNull();
  });

  it("ignores other cookies on the same header", () => {
    expect(
      readReturnToCookie("foo=bar; auth_return_to=%2Fdashboard; baz=qux"),
    ).toBe("/dashboard");
  });
});
