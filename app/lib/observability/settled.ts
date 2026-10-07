/**
 * Normalize Promise.allSettled results into a log-safe record keyed by job
 * name. Never emits raw Error objects — rejected entries collapse to
 * `{ status: "failed" }` so the caller can log the Error via
 * `logError(..., r.reason)` separately without info-level payloads leaking
 * un-serialized stacks.
 */
export type SettledEntry =
  | { status: "ok"; value: unknown }
  | { status: "failed" };

export function summarizeAllSettled<T extends readonly string[]>(
  jobs: T,
  results: PromiseSettledResult<unknown>[],
): Record<T[number], SettledEntry> {
  const out = {} as Record<string, SettledEntry>;
  for (const [i, r] of results.entries()) {
    out[jobs[i]] =
      r.status === "fulfilled"
        ? { status: "ok", value: r.value }
        : { status: "failed" };
  }
  return out as Record<T[number], SettledEntry>;
}
