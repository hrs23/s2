// AuthorizationService: Centralized authorization policy decisions (PDP pattern).
// Pure logic — no DB dependencies. Delegates scope geometry to scope.ts.

import { absolutePathToClient } from "~/lib/files/paths";
import { coveredPaths, resolveAccess } from "./scope";
import type { AccessLevel, AccessPathRow, AuthContext } from "./types";

/**
 * Public contract for the authorization PDP.
 * Consumers (service and transport layers) should depend on this interface, not the
 * concrete `AuthorizationService` class.
 */
export interface IAuthorizationService {
  checkAbsolutePath(
    auth: AuthContext,
    absolutePath: string,
    action: "read" | "write",
  ): boolean;
  filterByScope<T>(
    auth: AuthContext,
    items: T[],
    getPath: (item: T) => string,
  ): T[];
  isVisibleInScope(auth: AuthContext, absolutePath: string): boolean;
  coveredClientPaths(auth: AuthContext, absolutePath: string): string[];
  validateDelegation(
    parentAuth: AuthContext,
    childBasePath: string,
    childPaths: Array<{ path: string; access: AccessLevel }>,
  ): { valid: boolean; reason?: string };
}

/** Check if a given access level permits the requested action. */
function levelPermits(
  level: AccessLevel | null,
  action: "read" | "write",
): boolean {
  if (level === null) return false;
  if (action === "read") return true; // both "read" and "write" permit read
  return level === "write"; // only "write" permits write
}

/** Check if child level is a subset of (or equal to) parent level. */
function isSubsetLevel(child: AccessLevel, parent: AccessLevel): boolean {
  if (child === "read") return true; // "read" is always a subset
  return parent === "write"; // "write" child requires "write" parent
}

export class AuthorizationService implements IAuthorizationService {
  /**
   * Check whether the given auth context is allowed to perform an action on an
   * absolute path (i.e. a path already prefixed with base_path).
   * - User auth: always allowed
   * - Token auth: checks if absolutePath is covered by the token's access_paths
   */
  checkAbsolutePath(
    auth: AuthContext,
    absolutePath: string,
    action: "read" | "write",
  ): boolean {
    if (auth.type === "user") return true;

    const level = resolveAccess(
      auth.base_path,
      auth.access_paths,
      absolutePath,
    );
    return levelPermits(level, action);
  }

  /**
   * Filter items by token scope using absolute paths. For user auth, returns all items unchanged.
   * Useful for directory listings scoped to token, etc.
   */
  filterByScope<T>(
    auth: AuthContext,
    items: T[],
    getPath: (item: T) => string,
  ): T[] {
    if (auth.type === "user") return items;
    return items.filter((item) =>
      this.checkAbsolutePath(auth, getPath(item), "read"),
    );
  }

  /**
   * Check whether a path should be visible in a directory listing for the given auth context.
   * A path is visible if:
   * 1. It is directly within the token's scope (checkAbsolutePath), OR
   * 2. Any access_path is a descendant of this path (ancestor visibility —
   *    the directory must be shown so clients can navigate to deeper scoped paths)
   *
   * For user auth, always returns true.
   */
  isVisibleInScope(auth: AuthContext, absolutePath: string): boolean {
    if (auth.type === "user") return true;
    // Direct scope check
    if (this.checkAbsolutePath(auth, absolutePath, "read")) return true;
    // Ancestor visibility: any access_path under this directory?
    return (
      coveredPaths(absolutePath, auth.base_path, auth.access_paths).length > 0
    );
  }

  /**
   * Return the client-relative paths of readable access_paths that are
   * strict descendants of `absolutePath`. Used by the ancestor
   * transform to address delete/put events at the affected scope roots.
   *
   * Deduplicates nested access_paths: if both `/a/b` and `/a/b/c` are
   * affected, only `/a/b` is returned (the latter is already covered).
   *
   * For user auth, returns empty array (no scope narrowing needed).
   */
  coveredClientPaths(auth: AuthContext, absolutePath: string): string[] {
    if (auth.type !== "token") return [];
    const covered = coveredPaths(
      absolutePath,
      auth.base_path,
      auth.access_paths,
    );
    // Convert to client-relative paths
    const result: string[] = [];
    for (const abs of covered) {
      const raw = abs === "/" ? "/" : abs.replace(/\/$/, "");
      const client = absolutePathToClient(auth.base_path, raw);
      if (client !== null) result.push(client);
    }
    return result;
  }

  /**
   * Validate that a child token's delegation scope is a subset of the parent's scope.
   * Used when creating tokens via delegation (s2_ token creating a child token).
   */
  validateDelegation(
    parentAuth: AuthContext,
    childBasePath: string,
    childPaths: Array<{ path: string; access: AccessLevel }>,
  ): { valid: boolean; reason?: string } {
    if (parentAuth.type !== "token") {
      // User auth can delegate anything
      return { valid: true };
    }

    if (!parentAuth.can_delegate) {
      return { valid: false, reason: "Parent token lacks delegate permission" };
    }

    const parentRoot = parentAuth.base_path;
    const parentPerms = parentAuth.access_paths;

    for (const perm of childPaths) {
      const childAbsolute = resolvePath(childBasePath, perm.path);
      const covering = this.findCoveringPath(
        parentRoot,
        parentPerms,
        childAbsolute,
      );

      if (!covering) {
        return {
          valid: false,
          reason: `Path ${perm.path} (resolved: ${childAbsolute}) is outside the delegatable scope`,
        };
      }

      if (!isSubsetLevel(perm.access, covering.access)) {
        return {
          valid: false,
          reason: `Cannot grant ${perm.access} on ${perm.path}: parent only has ${covering.access}`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Find the most specific parent access path that covers the given child path.
   * Returns the covering access path or undefined if none covers it.
   */
  private findCoveringPath(
    parentRoot: string,
    parentPerms: AccessPathRow[],
    childAbsolute: string,
  ): AccessPathRow | undefined {
    return parentPerms
      .filter((pp) => {
        const parentAbsolute = resolvePath(parentRoot, pp.path);
        return pathIsUnder(childAbsolute, parentAbsolute);
      })
      .sort((a, b) => {
        const aLen = resolvePath(parentRoot, a.path).length;
        const bLen = resolvePath(parentRoot, b.path).length;
        return bLen - aLen; // Most specific (longest) first
      })[0];
  }
}

// Local imports for delegation logic (these stay in paths.ts as they're path operations)
import { pathIsUnder, resolvePath } from "~/lib/files/paths";
