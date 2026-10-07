import { describe, expect, it } from "vitest";
import { coveredPaths, resolveAccess } from "./scope";

describe("resolveAccess", () => {
  it("root scope with write grants write to any path", () => {
    expect(
      resolveAccess("/", [{ path: "", access: "write" }], "/any/file.txt"),
    ).toBe("write");
  });

  it("root scope with read grants read", () => {
    expect(
      resolveAccess("/", [{ path: "", access: "read" }], "/file.txt"),
    ).toBe("read");
  });

  it("scoped path matches descendants", () => {
    expect(
      resolveAccess("/", [{ path: "docs", access: "write" }], "/docs/a.txt"),
    ).toBe("write");
  });

  it("scoped path does not match siblings", () => {
    expect(
      resolveAccess("/", [{ path: "docs", access: "write" }], "/photos/a.jpg"),
    ).toBeNull();
  });

  it("non-root base_path restricts scope", () => {
    expect(
      resolveAccess(
        "/projects",
        [{ path: "", access: "write" }],
        "/projects/src/main.ts",
      ),
    ).toBe("write");
    expect(
      resolveAccess(
        "/projects",
        [{ path: "", access: "write" }],
        "/other/file",
      ),
    ).toBeNull();
  });

  it("multiple access paths: most permissive wins", () => {
    expect(
      resolveAccess(
        "/",
        [
          { path: "docs", access: "read" },
          { path: "docs", access: "write" },
        ],
        "/docs/readme",
      ),
    ).toBe("write");
  });

  it("path boundary: /docs does not match /documents", () => {
    expect(
      resolveAccess(
        "/",
        [{ path: "docs", access: "write" }],
        "/documents/file.txt",
      ),
    ).toBeNull();
  });
});

describe("coveredPaths", () => {
  it("returns strict descendants of the path", () => {
    const result = coveredPaths("/", "/", [
      { path: "docs", access: "read" },
      { path: "photos", access: "write" },
    ]);
    expect(result).toEqual(["/docs/", "/photos/"]);
  });

  it("returns empty for path with no descendants in scope", () => {
    const result = coveredPaths("/other", "/", [
      { path: "docs", access: "read" },
    ]);
    expect(result).toEqual([]);
  });

  it("deduplicates nested candidates", () => {
    const result = coveredPaths("/", "/", [
      { path: "a/b", access: "read" },
      { path: "a/b/c", access: "read" },
    ]);
    expect(result).toEqual(["/a/b/"]);
  });

  it("non-root base_path resolves correctly", () => {
    const result = coveredPaths("/projects", "/projects", [
      { path: "src", access: "read" },
    ]);
    expect(result).toEqual(["/projects/src/"]);
  });

  it("exact match is not a strict descendant", () => {
    const result = coveredPaths("/docs", "/", [
      { path: "docs", access: "read" },
    ]);
    expect(result).toEqual([]);
  });
});
