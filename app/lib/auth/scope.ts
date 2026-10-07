// Scope geometry — pure functions for access_paths-based scope calculations.
// No AuthContext awareness; no DB access. Usable on both client and server.

import type { AccessLevel, AccessPathRow } from "~/lib/auth/types";
import { joinPaths, normalizePath } from "~/lib/files/paths";

/**
 * Determine the maximum access level for `absolutePath` within a scope
 * defined by `basePath` + `accessPaths`. Returns null if the path is
 * outside the scope entirely.
 */
export function resolveAccess(
  basePath: string,
  accessPaths: readonly AccessPathRow[],
  absolutePath: string,
): AccessLevel | null {
  let maxLevel: AccessLevel | null = null;
  for (const ap of accessPaths) {
    const resolved = normalizePath(joinPaths(basePath, ap.path).full);
    if (
      normalizePath(absolutePath).startsWith(resolved) ||
      absolutePath === joinPaths(basePath, ap.path).full
    ) {
      if (ap.access === "write") return "write";
      maxLevel = "read";
    }
  }
  return maxLevel;
}

/**
 * Return the absolute paths of access_paths that are strict descendants
 * of `absolutePath`. Used to find which scope roots are "covered" by
 * (i.e. nested under) a given directory.
 *
 * Deduplicates nested results: if both `/a/b` and `/a/b/c` are covered,
 * only `/a/b` is returned.
 */
export function coveredPaths(
  absolutePath: string,
  basePath: string,
  accessPaths: readonly AccessPathRow[],
): string[] {
  const normalizedPath = normalizePath(absolutePath);
  const candidates: string[] = [];
  for (const ap of accessPaths) {
    const absoluteScope = normalizePath(joinPaths(basePath, ap.path).full);
    if (
      absoluteScope.startsWith(normalizedPath) &&
      absoluteScope !== normalizedPath
    ) {
      candidates.push(absoluteScope);
    }
  }
  // Drop any candidate that is itself inside another candidate
  return candidates.filter(
    (c) => !candidates.some((other) => other !== c && c.startsWith(other)),
  );
}
