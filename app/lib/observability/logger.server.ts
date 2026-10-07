/**
 * Structured server-side logger.
 *
 * Emits one JSON object per log, aligned with OpenTelemetry Logs semantic
 * conventions:
 *
 *   { component, event, ...attrs, err? }
 *
 * `console.*` arguments are forwarded as the log body. Passing a single object produces a clean JSON line where
 * every field is queryable via `| json | component="..."`.
 *
 * ## Call convention
 *
 *   logInfo(component, event, attrs?);
 *   logWarn(component, event, attrs?, err?);
 *   logError(component, event, attrs?, err?);
 *
 * - `component` names the module (`"cron"`, `"file_service.move"`).
 *   Use lowercase snake_case with dots for
 *   hierarchy.
 * - `event` is a snake_case verb phrase describing what happened
 *   (`"completed"`, `"signature_verification_failed"`).
 * - `attrs` is an arbitrary plain object. Do NOT string-concatenate IDs
 *   into `event` — keep them as fields so log tooling can group by them.
 * - `err` is serialized to `{ err: { name, message, stack, cause? } }`.
 *   Passing an Error directly (instead of via this helper) produces
 *   `"[object Object]"` in logs, which is the bug this module fixes.
 *
 * ## PII — caller responsibility
 *
 * Any value placed in `attrs`, or reachable via `err.message` / `err.stack`,
 * ships to the log sink verbatim. `serializeError` preserves the full message and
 * stack on purpose (debuggability) and performs no redaction.
 *
 * Per `docs/pii.md`, PII must not enter logs. Errors originating from layers
 * that may embed filenames / full paths / request bodies into their message
 * (FS, object storage, DB, external fetch) MUST be caught at that layer and
 * re-thrown with a sanitized message — typically referencing `node_id` in
 * place of any path. Do NOT rely on this logger to redact for you.
 */

export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const base: Record<string, unknown> = {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
    if (err.cause !== undefined) {
      base.cause = serializeError(err.cause);
    }
    return base;
  }

  if (typeof err === "object" && err !== null) {
    try {
      return { value: JSON.parse(JSON.stringify(err)) };
    } catch {
      return { value: String(err) };
    }
  }

  return { value: String(err) };
}

export function logInfo(
  component: string,
  event: string,
  attrs: Record<string, unknown> = {},
): void {
  // biome-ignore lint/suspicious/noConsole: structured logger output target
  console.log({ component, event, ...attrs });
}

export function logWarn(
  component: string,
  event: string,
  attrs: Record<string, unknown> = {},
  err?: unknown,
): void {
  const payload =
    err !== undefined
      ? { component, event, ...attrs, err: serializeError(err) }
      : { component, event, ...attrs };
  // biome-ignore lint/suspicious/noConsole: structured logger output target
  console.warn(payload);
}

export function logError(
  component: string,
  event: string,
  attrs: Record<string, unknown> = {},
  err?: unknown,
): void {
  const payload =
    err !== undefined
      ? { component, event, ...attrs, err: serializeError(err) }
      : { component, event, ...attrs };
  // biome-ignore lint/suspicious/noConsole: structured logger output target
  console.error(payload);
}
