import { describe, expect, it } from "vitest";
import { splitPath } from "~/lib/files/paths";
import { extractDavPath, parseBasicAuth } from "./dav";

describe("parseBasicAuth", () => {
  function req(authHeader?: string): Request {
    const headers = new Headers();
    if (authHeader) headers.set("Authorization", authHeader);
    return new Request("http://localhost/dav/", { headers });
  }

  it("extracts password from valid Basic auth", () => {
    const encoded = btoa("user:s2_token123");
    expect(parseBasicAuth(req(`Basic ${encoded}`))).toBe("s2_token123");
  });

  it("returns null when no Authorization header", () => {
    expect(parseBasicAuth(req())).toBeNull();
  });

  it("returns null for Bearer auth", () => {
    expect(parseBasicAuth(req("Bearer some_token"))).toBeNull();
  });

  it("returns null for invalid base64", () => {
    expect(parseBasicAuth(req("Basic !!!invalid!!!"))).toBeNull();
  });

  it("returns null when no colon in decoded value", () => {
    const encoded = btoa("no-colon-here");
    expect(parseBasicAuth(req(`Basic ${encoded}`))).toBeNull();
  });

  it("handles empty username (colon at start)", () => {
    const encoded = btoa(":password_only");
    expect(parseBasicAuth(req(`Basic ${encoded}`))).toBe("password_only");
  });

  it("handles password with colons", () => {
    const encoded = btoa("user:pass:with:colons");
    expect(parseBasicAuth(req(`Basic ${encoded}`))).toBe("pass:with:colons");
  });
});

describe("extractDavPath", () => {
  it("returns null for malformed percent-encoding", () => {
    expect(extractDavPath("http://localhost/dav/%E0%A4%A")).toBeNull();
  });

  it("extracts path after /dav", () => {
    expect(extractDavPath("http://localhost/dav/notes/foo.txt")).toBe(
      "/notes/foo.txt",
    );
  });

  it("returns / for /dav root", () => {
    expect(extractDavPath("http://localhost/dav")).toBe("/");
    expect(extractDavPath("http://localhost/dav/")).toBe("/");
  });

  it("decodes URL-encoded characters", () => {
    expect(extractDavPath("http://localhost/dav/my%20file.txt")).toBe(
      "/my file.txt",
    );
  });

  it("returns / for non-dav paths", () => {
    expect(extractDavPath("http://localhost/other/path")).toBe("/");
  });

  it("preserves trailing slash", () => {
    expect(extractDavPath("http://localhost/dav/folder/")).toBe("/folder/");
  });
});

describe("splitPath", () => {
  it("splits path into segments", () => {
    expect(splitPath("/docs/project/report.pdf")).toEqual([
      "docs",
      "project",
      "report.pdf",
    ]);
  });

  it("handles root path", () => {
    expect(splitPath("/")).toEqual([]);
    expect(splitPath("")).toEqual([]);
  });

  it("handles trailing slashes", () => {
    expect(splitPath("/docs/")).toEqual(["docs"]);
  });

  it("handles multiple consecutive slashes", () => {
    expect(splitPath("//docs///file.txt")).toEqual(["docs", "file.txt"]);
  });
});
