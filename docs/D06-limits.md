# Limits and quota

`user_limits` per user; `0` = unlimited (default). Operators set values directly in the database.

| column | meaning |
|---|---|
| `storage_limit_bytes` | max logical storage |
| `grant_limit` | max grants (manual + delegated + OAuth) |
| `revision_limit` | max revisions kept per file |

- `user_storage.bytes_used` is updated inside write transactions; uploads are checked at pre-flight and at commit.
- Trash and past revisions count; deletes reduce usage.
- Over-limit users cannot write; files are never auto-deleted.
- `revision_limit` prunes the oldest revisions of a file inside the write transaction.
