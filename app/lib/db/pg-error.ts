// Shared helpers for inspecting Postgres error objects thrown by `pg`
// (node-postgres). pg surfaces SQLSTATE in `err.code` as a 5-char string —
// see https://www.postgresql.org/docs/current/errcodes-appendix.html.
//
// We avoid importing pg's `DatabaseError` class to dodge instanceof brittleness
// across vendored copies / dual installs; a shape check is enough.

/** SQLSTATE 23503: foreign_key_violation (ON DELETE RESTRICT etc.). */
export const PG_FK_VIOLATION = "23503";

export interface PgError extends Error {
  code: string;
}

export function isPgError(e: unknown): e is PgError {
  if (!(e instanceof Error)) return false;
  const code = (e as unknown as { code?: unknown }).code;
  // SQLSTATE codes are exactly 5 characters.
  return typeof code === "string" && code.length === 5;
}
