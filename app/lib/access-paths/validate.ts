import type { AccessPath } from "~/lib/api";

export type AccessPathsError =
  | { kind: "duplicate_paths" }
  | { kind: "min_rows" };

/**
 * Normalize raw access path input from any client surface (consent
 * POST, PATCH from /connections, future API). Trims whitespace and drops
 * whitespace-only rows. Preserves path="" (canonical root form).
 */
export function trimAccessPathRows(
  raw: ReadonlyArray<{ path: string; access: "read" | "write" }>,
): AccessPath[] {
  const out: AccessPath[] = [];
  for (const row of raw) {
    const path = row.path.trim();
    if (path === "" && row.path !== "") continue; // drop whitespace-only, keep literal ""
    out.push({ path, access: row.access });
  }
  return out;
}

export function validateAccessPaths(
  paths: AccessPath[],
  options: { minRows?: number } = {},
): AccessPathsError | null {
  const minRows = options.minRows ?? 0;
  if (paths.length < minRows) return { kind: "min_rows" };
  const values = paths.map((p) => p.path);
  if (new Set(values).size !== values.length)
    return { kind: "duplicate_paths" };
  return null;
}
