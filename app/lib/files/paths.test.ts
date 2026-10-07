import { describe, expect, it } from "vitest";
import {
  absolutePathToClient,
  canonicalizeAccessPath,
  joinPaths,
  normalizePath,
  parseClientPath,
  pathIsUnder,
  validateAccessPath,
  validateBasePath,
  validateClientPath,
} from "./paths";

describe("normalizePath", () => {
  it("appends / if missing", () => {
    expect(normalizePath("/photos")).toBe("/photos/");
  });
  it("keeps trailing /", () => {
    expect(normalizePath("/photos/")).toBe("/photos/");
  });
  it("handles root", () => {
    expect(normalizePath("/")).toBe("/");
  });
});

describe("pathIsUnder", () => {
  it("root is under root", () => {
    expect(pathIsUnder("/", "/")).toBe(true);
  });
  it("child under parent", () => {
    expect(pathIsUnder("/photos/cat.jpg", "/photos")).toBe(true);
  });
  it("not under different parent", () => {
    expect(pathIsUnder("/docs/x", "/photos")).toBe(false);
  });
  it("similar prefix does not match", () => {
    expect(pathIsUnder("/photosXtra/a", "/photos")).toBe(false);
  });
});

describe("joinPaths", () => {
  it('base="/", access="/" → full="/"', () => {
    const r = joinPaths("/", "/");
    expect(r.full).toBe("/");
    expect(r.base).toBe("");
    expect(r.suffix).toBe("");
  });

  it('base="/", access="" → full="/"', () => {
    const r = joinPaths("/", "");
    expect(r.full).toBe("/");
  });

  it('base="/", access="photos" → full="/photos"', () => {
    const r = joinPaths("/", "photos");
    expect(r.full).toBe("/photos");
  });

  it('base="/", access="/photos" → full="/photos" (leading / stripped)', () => {
    const r = joinPaths("/", "/photos");
    expect(r.full).toBe("/photos");
  });

  it('base="/test", access="/" → full="/test/"', () => {
    const r = joinPaths("/test", "/");
    expect(r.full).toBe("/test/");
  });

  it('base="/test", access="" → full="/test/"', () => {
    const r = joinPaths("/test", "");
    expect(r.full).toBe("/test/");
  });

  it('base="/test", access="docs" → full="/test/docs"', () => {
    const r = joinPaths("/test", "docs");
    expect(r.full).toBe("/test/docs");
  });

  it('base="/test", access="/docs" → full="/test/docs"', () => {
    const r = joinPaths("/test", "/docs");
    expect(r.full).toBe("/test/docs");
  });

  it('base="/test/", access="docs" → full="/test/docs" (no double slash)', () => {
    const r = joinPaths("/test/", "docs");
    expect(r.full).toBe("/test/docs");
  });
});

describe("validateClientPath", () => {
  it("allows normal paths", () => {
    expect(validateClientPath("docs/foo.txt")).toBeNull();
    expect(validateClientPath("/notes/bar/")).toBeNull();
    expect(validateClientPath("")).toBeNull();
    expect(validateClientPath("/")).toBeNull();
  });

  it("rejects .. segments", () => {
    expect(validateClientPath("..")).not.toBeNull();
    expect(validateClientPath("../etc/passwd")).not.toBeNull();
    expect(validateClientPath("docs/../../secret")).not.toBeNull();
    expect(validateClientPath("foo/..")).not.toBeNull();
  });

  it("allows .. within segment names", () => {
    expect(validateClientPath("foo..bar")).toBeNull();
    expect(validateClientPath("...")).toBeNull();
    expect(validateClientPath("..hidden")).toBeNull();
  });

  it("rejects null bytes", () => {
    expect(validateClientPath("foo\0bar")).not.toBeNull();
  });
});

describe("validateBasePath", () => {
  it("accepts root", () => {
    expect(validateBasePath("/")).toBeNull();
  });

  it("accepts absolute paths", () => {
    expect(validateBasePath("/photos")).toBeNull();
    expect(validateBasePath("/photos/2024/summer")).toBeNull();
  });

  it("rejects missing leading slash", () => {
    expect(validateBasePath("photos")).not.toBeNull();
    expect(validateBasePath("")).not.toBeNull();
  });

  it("rejects trailing slash (except root)", () => {
    expect(validateBasePath("/photos/")).not.toBeNull();
    expect(validateBasePath("/")).toBeNull();
  });

  it("rejects // anywhere", () => {
    expect(validateBasePath("//")).not.toBeNull();
    expect(validateBasePath("/foo//bar")).not.toBeNull();
  });

  it("rejects . and .. segments", () => {
    expect(validateBasePath("/.")).not.toBeNull();
    expect(validateBasePath("/foo/./bar")).not.toBeNull();
    expect(validateBasePath("/../etc")).not.toBeNull();
    expect(validateBasePath("/foo/../bar")).not.toBeNull();
    expect(validateBasePath("/..")).not.toBeNull();
  });

  it("rejects NUL and newlines", () => {
    expect(validateBasePath("/foo\0bar")).not.toBeNull();
    expect(validateBasePath("/foo\nbar")).not.toBeNull();
    expect(validateBasePath("/foo\rbar")).not.toBeNull();
  });

  it("rejects leading/trailing whitespace", () => {
    expect(validateBasePath(" /foo")).not.toBeNull();
    expect(validateBasePath("/foo ")).not.toBeNull();
  });
});

describe("validateAccessPath (basePath-relative)", () => {
  it("accepts empty string as canonical root", () => {
    expect(validateAccessPath("")).toBeNull();
  });

  it("accepts relative paths", () => {
    expect(validateAccessPath("foo")).toBeNull();
    expect(validateAccessPath("foo/bar")).toBeNull();
    expect(validateAccessPath("projects/myapp/src/lib")).toBeNull();
    expect(validateAccessPath(".config")).toBeNull(); // leading dot in a segment is OK (hidden file)
    expect(validateAccessPath("my photos")).toBeNull(); // spaces inside segments OK
  });

  it("rejects leading slash (no absolute form)", () => {
    expect(validateAccessPath("/")).not.toBeNull();
    expect(validateAccessPath("/foo")).not.toBeNull();
    expect(validateAccessPath("/foo/bar")).not.toBeNull();
  });

  it("accepts trailing slash (canonicalize strips it)", () => {
    expect(validateAccessPath("foo/")).toBeNull();
  });

  it("rejects // anywhere", () => {
    expect(validateAccessPath("foo//bar")).not.toBeNull();
  });

  it("rejects . and .. segments", () => {
    expect(validateAccessPath(".")).not.toBeNull();
    expect(validateAccessPath("..")).not.toBeNull();
    expect(validateAccessPath("foo/./bar")).not.toBeNull();
    expect(validateAccessPath("foo/../bar")).not.toBeNull();
  });

  it("rejects NUL and newlines", () => {
    expect(validateAccessPath("foo\0bar")).not.toBeNull();
    expect(validateAccessPath("foo\nbar")).not.toBeNull();
    expect(validateAccessPath("foo\rbar")).not.toBeNull();
  });

  it("rejects leading/trailing whitespace", () => {
    expect(validateAccessPath(" foo")).not.toBeNull();
    expect(validateAccessPath("foo ")).not.toBeNull();
  });
});

// clientSegmentsToAbsolute is now internal, tested via parseClientPath

describe("absolutePathToClient", () => {
  it("root base_path: returns absolute path unchanged", () => {
    expect(absolutePathToClient("/", "/agents/foo.txt")).toBe(
      "/agents/foo.txt",
    );
  });
  it("non-root: strips base_path prefix", () => {
    expect(absolutePathToClient("/agents/", "/agents/foo.txt")).toBe(
      "/foo.txt",
    );
  });
  it("path equals base_path exactly: returns /", () => {
    expect(absolutePathToClient("/agents/", "/agents")).toBe("/");
  });
  it("path outside base_path: returns null", () => {
    expect(absolutePathToClient("/agents/", "/other/foo.txt")).toBeNull();
  });
  it("base_path without trailing slash is handled", () => {
    expect(absolutePathToClient("/agents", "/agents/foo.txt")).toBe("/foo.txt");
  });
});

// toAbsoluteSegments is now internal, tested via parseClientPath

describe("parseClientPath", () => {
  const auth = { type: "token", base_path: "/agents/" };

  it("valid path: returns segments", () => {
    const result = parseClientPath("foo/bar.txt", auth);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.segments).toEqual(["agents", "foo", "bar.txt"]);
  });
  it("path with leading slashes: strips them", () => {
    const result = parseClientPath("///foo.txt", auth);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.segments).toEqual(["agents", "foo.txt"]);
  });
  it("double slashes in middle: collapsed by splitPath filter", () => {
    const result = parseClientPath("foo//bar.txt", auth);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.segments).toEqual(["agents", "foo", "bar.txt"]);
  });
  it("path traversal: returns error", () => {
    const result = parseClientPath("../etc/passwd", auth);
    expect(result.ok).toBe(false);
  });
  it("null byte: returns error", () => {
    const result = parseClientPath("foo\0bar", auth);
    expect(result.ok).toBe(false);
  });
  it("empty path: returns empty segments (virtual root)", () => {
    const result = parseClientPath("", auth);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.segments).toEqual(["agents"]);
  });
});

// canTokenAccess tests moved to scope.test.ts (resolveAccess)

describe("canonicalizeAccessPath (basePath-relative)", () => {
  it('"" stays as ""', () => {
    expect(canonicalizeAccessPath("")).toBe("");
  });
  it('legacy "/" canonicalizes to ""', () => {
    expect(canonicalizeAccessPath("/")).toBe("");
  });
  it("strips trailing slash", () => {
    expect(canonicalizeAccessPath("photos/")).toBe("photos");
    expect(canonicalizeAccessPath("docs/project/")).toBe("docs/project");
  });
  it("no trailing slash is a no-op", () => {
    expect(canonicalizeAccessPath("photos")).toBe("photos");
    expect(canonicalizeAccessPath("foo/bar")).toBe("foo/bar");
  });
});
