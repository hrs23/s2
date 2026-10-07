// Helpers for normalizing pg driver primitives at the repository boundary.
//
// pg returns TIMESTAMP / TIMESTAMPTZ as `Date` objects by default. Some
// repositories declare these columns as `string` (ISO 8601) in their domain
// types; this helper makes the runtime value match the declared contract so
// services and gateways don't have to defend against `Date` leaks.
//
// Repositories that want a `Date` contract simply skip this helper.

/**
 * Coerce a pg-returned timestamp value to an ISO 8601 string.
 *
 * - `Date` → `Date.toISOString()` (canonical UTC, `T` separator, `Z` suffix)
 * - `string` → returned as-is (already-coerced caller, or non-default parser)
 * - `null` / `undefined` → `null`
 * - anything else → `String(value)` (defensive fallback)
 */
export function coercePgInstant(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return String(value);
}
