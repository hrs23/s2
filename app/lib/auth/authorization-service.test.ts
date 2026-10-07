import { describe, expect, it } from "vitest";
import { AuthorizationService } from "~/lib/auth/authorization-service.server";
import type { AuthContext } from "~/lib/auth/types";

function userAuth(userId = "user-1"): AuthContext {
  return { type: "user", user_id: userId };
}

function tokenAuth(
  overrides: Partial<Extract<AuthContext, { type: "token" }>> = {},
): Extract<AuthContext, { type: "token" }> {
  return {
    type: "token",
    token_id: "tok-1",
    user_id: "user-1",
    base_path: "/",
    can_delegate: false,
    access_paths: [{ path: "", access: "write" }],
    resource: null,
    ...overrides,
  };
}

describe("AuthorizationService", () => {
  const authz = new AuthorizationService();

  // ---- checkAbsolutePath ----

  describe("checkAbsolutePath", () => {
    it("user auth always returns true", () => {
      expect(authz.checkAbsolutePath(userAuth(), "/any/path", "read")).toBe(
        true,
      );
      expect(authz.checkAbsolutePath(userAuth(), "/any/path", "write")).toBe(
        true,
      );
    });

    it("root token with full permissions allows everything", () => {
      const auth = tokenAuth();
      expect(authz.checkAbsolutePath(auth, "/docs/file.txt", "read")).toBe(
        true,
      );
      expect(authz.checkAbsolutePath(auth, "/docs/file.txt", "write")).toBe(
        true,
      );
    });

    it("token with read-only access on /docs", () => {
      const auth = tokenAuth({
        access_paths: [{ path: "docs", access: "read" }],
      });
      expect(authz.checkAbsolutePath(auth, "/docs", "read")).toBe(true);
      expect(authz.checkAbsolutePath(auth, "/docs", "write")).toBe(false);
      expect(authz.checkAbsolutePath(auth, "/docs/report.pdf", "read")).toBe(
        true,
      );
      expect(authz.checkAbsolutePath(auth, "/photos", "read")).toBe(false);
    });

    it("token with multiple access paths", () => {
      const auth = tokenAuth({
        access_paths: [
          { path: "docs", access: "read" },
          { path: "uploads", access: "write" },
        ],
      });
      expect(authz.checkAbsolutePath(auth, "/docs/file.txt", "read")).toBe(
        true,
      );
      expect(authz.checkAbsolutePath(auth, "/docs/file.txt", "write")).toBe(
        false,
      );
      expect(authz.checkAbsolutePath(auth, "/uploads/img.png", "read")).toBe(
        true,
      );
      expect(authz.checkAbsolutePath(auth, "/uploads/img.png", "write")).toBe(
        true,
      );
    });

    it("deep nested path is allowed when ancestor is in scope", () => {
      const auth = tokenAuth({
        access_paths: [{ path: "projects", access: "read" }],
      });
      expect(
        authz.checkAbsolutePath(auth, "/projects/a/b/c/deep.txt", "read"),
      ).toBe(true);
    });

    it("/docs does NOT match /documents (path boundary)", () => {
      const auth = tokenAuth({
        access_paths: [{ path: "docs", access: "write" }],
      });
      expect(authz.checkAbsolutePath(auth, "/docs/file.txt", "read")).toBe(
        true,
      );
      expect(authz.checkAbsolutePath(auth, "/documents/file.txt", "read")).toBe(
        false,
      );
    });

    it("non-root base_path restricts scope", () => {
      const auth = tokenAuth({
        base_path: "/projects/myapp",
        access_paths: [{ path: "", access: "write" }],
      });
      expect(authz.checkAbsolutePath(auth, "/projects/myapp/src", "read")).toBe(
        true,
      );
      expect(authz.checkAbsolutePath(auth, "/other", "read")).toBe(false);
    });

    it("non-root base_path with sub-path access", () => {
      const auth = tokenAuth({
        base_path: "/projects/myapp",
        access_paths: [{ path: "src", access: "read" }],
      });
      expect(
        authz.checkAbsolutePath(auth, "/projects/myapp/src/main.ts", "read"),
      ).toBe(true);
      expect(
        authz.checkAbsolutePath(auth, "/projects/myapp/docs/readme", "read"),
      ).toBe(false);
      expect(authz.checkAbsolutePath(auth, "/other/file", "read")).toBe(false);
    });
  });

  // ---- filterByScope ----

  describe("filterByScope", () => {
    const items = [
      { id: 1, path: "/docs/a.txt" },
      { id: 2, path: "/photos/b.jpg" },
      { id: 3, path: "/uploads/c.bin" },
    ];

    it("user auth returns all items", () => {
      const result = authz.filterByScope(userAuth(), items, (i) => i.path);
      expect(result).toHaveLength(3);
    });

    it("root token returns all items", () => {
      const auth = tokenAuth();
      const result = authz.filterByScope(auth, items, (i) => i.path);
      expect(result).toHaveLength(3);
    });

    it("token scoped to /docs returns only docs items", () => {
      const auth = tokenAuth({
        access_paths: [{ path: "docs", access: "read" }],
      });
      const result = authz.filterByScope(auth, items, (i) => i.path);
      expect(result).toEqual([{ id: 1, path: "/docs/a.txt" }]);
    });

    it("token with write access returns all matching items", () => {
      const auth = tokenAuth({
        access_paths: [{ path: "", access: "write" }],
      });
      const result = authz.filterByScope(auth, items, (i) => i.path);
      expect(result).toHaveLength(3);
    });

    it("works with empty items array", () => {
      const auth = tokenAuth();
      const result = authz.filterByScope(
        auth,
        [],
        (i: { path: string }) => i.path,
      );
      expect(result).toEqual([]);
    });
  });

  // ---- validateDelegation ----

  describe("validateDelegation", () => {
    it("user auth can delegate anything", () => {
      const result = authz.validateDelegation(userAuth(), "/", [
        { path: "", access: "write" },
      ]);
      expect(result).toEqual({ valid: true });
    });

    it("token without can_delegate is rejected", () => {
      const parent = tokenAuth({ can_delegate: false });
      const result = authz.validateDelegation(parent, "/", [
        { path: "", access: "write" },
      ]);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("delegate permission");
    });

    it("valid delegation: child is subset of parent", () => {
      const parent = tokenAuth({
        can_delegate: true,
        access_paths: [{ path: "", access: "write" }],
      });
      const result = authz.validateDelegation(parent, "/docs", [
        { path: "", access: "read" },
      ]);
      expect(result).toEqual({ valid: true });
    });

    it("invalid delegation: child path outside parent scope", () => {
      const parent = tokenAuth({
        can_delegate: true,
        base_path: "/docs",
        access_paths: [{ path: "", access: "write" }],
      });
      const result = authz.validateDelegation(parent, "/photos", [
        { path: "", access: "read" },
      ]);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("outside the delegatable scope");
    });

    it("invalid delegation: child requests write but parent has read-only", () => {
      const parent = tokenAuth({
        can_delegate: true,
        access_paths: [{ path: "", access: "read" }],
      });
      const result = authz.validateDelegation(parent, "/", [
        { path: "docs", access: "write" },
      ]);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("parent only has read");
    });

    it("valid delegation with narrower scope", () => {
      const parent = tokenAuth({
        can_delegate: true,
        access_paths: [
          { path: "docs", access: "write" },
          { path: "photos", access: "read" },
        ],
      });
      const result = authz.validateDelegation(parent, "/", [
        { path: "docs/reports", access: "read" },
      ]);
      expect(result).toEqual({ valid: true });
    });

    it("valid delegation: multiple child paths all covered", () => {
      const parent = tokenAuth({
        can_delegate: true,
        access_paths: [
          { path: "docs", access: "write" },
          { path: "photos", access: "read" },
        ],
      });
      const result = authz.validateDelegation(parent, "/", [
        { path: "docs", access: "read" },
        { path: "photos", access: "read" },
      ]);
      expect(result).toEqual({ valid: true });
    });

    it("invalid delegation: one of multiple child paths not covered", () => {
      const parent = tokenAuth({
        can_delegate: true,
        access_paths: [{ path: "docs", access: "write" }],
      });
      const result = authz.validateDelegation(parent, "/", [
        { path: "docs", access: "read" },
        { path: "videos", access: "read" },
      ]);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("outside the delegatable scope");
    });
  });

  // ---- isVisibleInScope ----

  describe("isVisibleInScope", () => {
    it("user auth always returns true", () => {
      expect(authz.isVisibleInScope(userAuth(), "/anything")).toBe(true);
    });

    it("returns true for path directly in scope", () => {
      const auth = tokenAuth({
        access_paths: [{ path: "docs", access: "read" }],
      });
      expect(authz.isVisibleInScope(auth, "/docs")).toBe(true);
      expect(authz.isVisibleInScope(auth, "/docs/file.txt")).toBe(true);
    });

    it("returns true for ancestor of scoped path", () => {
      const auth = tokenAuth({
        access_paths: [{ path: "docs/project", access: "read" }],
      });
      expect(authz.isVisibleInScope(auth, "/")).toBe(true);
      expect(authz.isVisibleInScope(auth, "/docs")).toBe(true);
    });

    it("returns false for path outside scope with no scoped descendants", () => {
      const auth = tokenAuth({
        access_paths: [{ path: "docs/project", access: "read" }],
      });
      expect(authz.isVisibleInScope(auth, "/other")).toBe(false);
      expect(authz.isVisibleInScope(auth, "/docs/archive")).toBe(false);
    });

    it("handles multiple disjoint scopes", () => {
      const auth = tokenAuth({
        access_paths: [
          { path: "a", access: "read" },
          { path: "b/c", access: "write" },
        ],
      });
      expect(authz.isVisibleInScope(auth, "/")).toBe(true);
      expect(authz.isVisibleInScope(auth, "/a")).toBe(true);
      expect(authz.isVisibleInScope(auth, "/b")).toBe(true);
      expect(authz.isVisibleInScope(auth, "/b/c")).toBe(true);
      expect(authz.isVisibleInScope(auth, "/x")).toBe(false);
    });

    it("handles non-root base_path", () => {
      const auth = tokenAuth({
        base_path: "/projects",
        access_paths: [{ path: "src", access: "read" }],
      });
      // /projects/src is the resolved scope
      expect(authz.isVisibleInScope(auth, "/projects")).toBe(true);
      expect(authz.isVisibleInScope(auth, "/projects/src")).toBe(true);
      expect(authz.isVisibleInScope(auth, "/projects/docs")).toBe(false);
    });
  });

  // ---- coveredClientPaths ----

  describe("coveredClientPaths", () => {
    it("user auth returns empty", () => {
      expect(authz.coveredClientPaths(userAuth(), "/")).toEqual([]);
    });

    it("returns client-relative paths of strict descendants", () => {
      const auth = tokenAuth({
        access_paths: [
          { path: "docs", access: "read" },
          { path: "photos", access: "write" },
        ],
      });
      const result = authz.coveredClientPaths(auth, "/");
      expect(result).toEqual(["/docs", "/photos"]);
    });

    it("returns empty when path has no descendants in scope", () => {
      const auth = tokenAuth({
        access_paths: [{ path: "docs", access: "read" }],
      });
      expect(authz.coveredClientPaths(auth, "/photos")).toEqual([]);
    });

    it("deduplicates nested access_paths", () => {
      const auth = tokenAuth({
        access_paths: [
          { path: "a/b", access: "read" },
          { path: "a/b/c", access: "read" },
        ],
      });
      const result = authz.coveredClientPaths(auth, "/");
      expect(result).toEqual(["/a/b"]);
    });

    it("handles non-root base_path", () => {
      const auth = tokenAuth({
        base_path: "/projects",
        access_paths: [{ path: "src", access: "read" }],
      });
      const result = authz.coveredClientPaths(auth, "/projects");
      expect(result).toEqual(["/src"]);
    });
  });
});
