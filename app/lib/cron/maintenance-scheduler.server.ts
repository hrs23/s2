import {
  DAILY_CRON,
  runDailyMaintenance,
} from "~/lib/cron/daily-maintenance.server";
import { logError, logInfo } from "~/lib/observability/logger.server";

export interface MaintenanceSchedulerOptions {
  /** When false, startMaintenanceScheduler is a no-op. Default true. */
  enabled?: boolean;
  /** 5-field UTC cron. Default DAILY_CRON (`0 17 * * *`). */
  cron?: string;
  /** Tick interval in ms. Default 30_000. */
  intervalMs?: number;
  /** Injected clock for tests. */
  now?: () => Date;
  /** Injected runner for tests. */
  run?: (env: Env) => Promise<void>;
}

export interface MaintenanceSchedulerHandle {
  stop: () => void;
}

/**
 * Start an in-process UTC cron ticker that runs daily maintenance.
 * Fires at most once per matching minute; overlaps are skipped.
 */
export function startMaintenanceScheduler(
  env: Env,
  options: MaintenanceSchedulerOptions = {},
): MaintenanceSchedulerHandle {
  const enabled = options.enabled ?? true;
  if (!enabled) {
    return { stop: () => {} };
  }

  const cron = options.cron ?? DAILY_CRON;
  assertFiveFieldCron(cron);
  const intervalMs = options.intervalMs ?? 30_000;
  const now = options.now ?? (() => new Date());
  const run = options.run ?? runDailyMaintenance;

  let lastFiredKey: string | null = null;
  let running = false;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    const date = now();
    if (!cronMatchesUtc(cron, date)) return;
    const key = minuteKey(date);
    if (key === lastFiredKey) return;
    if (running) return;
    lastFiredKey = key;
    running = true;
    logInfo("cron", "scheduler_fire", { cron, at: date.toISOString() });
    void run(env)
      .catch((error) => {
        logError("cron", "scheduler_run_failed", {}, error);
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, intervalMs);
  // Do not keep the process alive solely for the ticker in one-shot CLIs.
  timer.unref?.();
  tick();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** True when `date` (UTC) matches a 5-field cron: min hour dom month dow. */
export function cronMatchesUtc(expression: string, date: Date): boolean {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parseCron(expression);
  return (
    fieldMatches(minute, date.getUTCMinutes(), 0, 59) &&
    fieldMatches(hour, date.getUTCHours(), 0, 23) &&
    fieldMatches(dayOfMonth, date.getUTCDate(), 1, 31) &&
    fieldMatches(month, date.getUTCMonth() + 1, 1, 12) &&
    fieldMatches(dayOfWeek, date.getUTCDay(), 0, 6)
  );
}

function assertFiveFieldCron(expression: string): void {
  parseCron(expression);
}

function parseCron(
  expression: string,
): [string, string, string, string, string] {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `MAINTENANCE_CRON must be a 5-field UTC cron, got ${JSON.stringify(expression)}`,
    );
  }
  return parts as [string, string, string, string, string];
}

function fieldMatches(
  field: string,
  value: number,
  min: number,
  max: number,
): boolean {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    if (part.includes("/")) {
      const [range, stepRaw] = part.split("/");
      const step = Number.parseInt(stepRaw, 10);
      if (!Number.isFinite(step) || step <= 0) continue;
      const [start, end] =
        range === "*"
          ? [min, max]
          : range.includes("-")
            ? range.split("-").map((n) => Number.parseInt(n, 10))
            : [Number.parseInt(range, 10), max];
      if (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        value >= start &&
        value <= end &&
        (value - start) % step === 0
      ) {
        return true;
      }
      continue;
    }
    if (part.includes("-")) {
      const [a, b] = part.split("-").map((n) => Number.parseInt(n, 10));
      if (
        Number.isFinite(a) &&
        Number.isFinite(b) &&
        value >= a &&
        value <= b
      ) {
        return true;
      }
      continue;
    }
    const n = Number.parseInt(part, 10);
    if (Number.isFinite(n) && n === value) return true;
  }
  return false;
}

function minuteKey(date: Date): string {
  return `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}-${date.getUTCHours()}-${date.getUTCMinutes()}`;
}
