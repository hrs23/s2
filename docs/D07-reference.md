# Reference

Schema source: `migrations/20260101000000_init.sql`. Better Auth tables are camelCase singular; S2 tables are snake_case plural.

## Ownership

```text
"user" ─┬─ session / account / verification / passkey / twoFactor
        ├─ user_limits / user_storage
        ├─ grants ─┬─ user_grants
        │          ├─ oauth_grants
        │          ├─ refresh_tokens
        │          ├─ grant_paths
        │          └─ access_tokens
        ├─ file_nodes ─ file_revisions
        ├─ upload_sessions ─ upload_session_chunks
        └─ oauth_authorization_codes

oauth_clients ─ oauth_grants / oauth_authorization_codes
file_revisions delete trigger ─ storage_tombstones
```

S2-owned tables reference `"user"(id)` and cascade on account delete. RLS-protected tables fail closed when `app.user_id` is unset.
Deleting `oauth_clients` cascades to OAuth grants and their grant/token rows.
