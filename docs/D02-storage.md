# Storage

Table ownership: [D07-reference.md](D07-reference.md). Code: `app/lib/files/`, `app/lib/storage/`.

- Bodies are 4 MB plaintext chunks, key `{storage_prefix}/c/{index:05d}`. Content and filenames are plaintext server-side.
- `content_version` is the CAS lock / ETag; `revision_id` (ULID) identifies an immutable revision; `hash` (SHA-256) lets clients skip downloads.
- PUT, restoreVersion and upload commit all CAS with `WHERE content_version = $base`.
- Names are NFC-normalized and case-sensitive.

## Upload

1. `POST /api/v1/uploads` - session (quota pre-flight, CAS base; expires in 24h)
2. `PUT /api/v1/uploads/:id/:chunk`
3. `POST /api/v1/uploads/:id/complete` - CAS, revision INSERT and `bytes_used` delta in one tx

Chunks are written outside the tx; orphans are reclaimed by maintenance.

## Trash and deletion

- Delete sets `deleted_at`; purge hard-deletes and cascades to revisions and sessions. Trash and old versions count toward quota ([D06-limits.md](D06-limits.md)).
- Never call storage adapter `.delete()` directly. Deleting `file_revisions` enqueues `storage_tombstones`; only `storage-gc` removes blobs, after `GC_GRACE_DAYS` (default 8; keep it longer than your DB restore window).
- Never `TRUNCATE file_revisions`: see [CONTRIBUTING.md](../CONTRIBUTING.md).
