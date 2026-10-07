// Cron job configuration — read from environment variables.
// All fields have sensible defaults so they're optional in each environment.
//
// To override, set environment variables:
//   TRASH_RETENTION_DAYS  — days before a trashed file is purged  (default: 30)
//   MAX_PAST_VERSIONS     — past revisions to keep per file (0 = disabled)  (default: 0)
//   GC_GRACE_DAYS         — days a storage_tombstones row sits before GC deletes blobs  (default: 8)
//   GC_BATCH_SIZE         — max tombstones GC processes per run  (default: 1000)

export interface CronConfig {
  trashRetentionDays: number;
  maxPastVersions: number;
  gcGraceDays: number;
  gcBatchSize: number;
}

export function readCronConfig(env: Env): CronConfig {
  const e = env;
  return {
    trashRetentionDays: pos(e.TRASH_RETENTION_DAYS, 30),
    maxPastVersions: nonNeg(e.MAX_PAST_VERSIONS, 0),
    gcGraceDays: pos(e.GC_GRACE_DAYS, 8),
    gcBatchSize: pos(e.GC_BATCH_SIZE, 1000),
  };
}

function pos(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNeg(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
