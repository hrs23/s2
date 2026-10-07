# Permissions

Code: `app/lib/auth/authorization-service.server.ts`, `app/lib/auth/scope.ts`, `app/lib/db/client.server.ts`.
OAuth flow: [D04-auth.md](D04-auth.md). Tables: [D07-reference.md](D07-reference.md).

## Model

- A grant (`grants`) has a `base_path` virtual root and `grant_paths(path, access)` rows (`read` / `write`; write includes read).
- Origins: `user_grants` ("API token", incl. delegation) and `oauth_grants` ("Connected app"), mutually exclusive per grant. Both share one `grant_limit` pool.
- Tokens are path x read/write only: no verb scopes, no wildcards.
- Paths outside `base_path` behave as nonexistent.

## Match rules

- Component-boundary prefix: `/foo` covers `/foo` and `/foo/*`, not `/foobar`.
- Checks use the target path: put/upload/delete the file, mkdir the directory, move/copy src and dest independently.
- In-scope writes create parent directories (no separate mkdir auth); scopes may name paths that do not exist yet.
- A token cannot delete or create its virtual root (WebDAV `/dav/` DELETE 400, MKCOL 405).
- Ancestors outside `base_path` are listed when a child scope is in range (`isVisibleInScope`).

## Consent

- Consent snapshot is frozen in `oauth_authorization_codes` and expanded into `oauth_grants` + `grant_paths` at token exchange.
- Re-consent replaces the grant (UNIQUE `(user_id, oauth_client_id)`); each DCR install has its own `client_id`.
- Disconnect deletes `oauth_grants`; tokens and paths cascade.
- `grant_limit` is checked in the UI and again after code exchange.

## Layers

| Layer | Protects | Where |
|---|---|---|
| Token | revoked / expired | `TokenService` |
| Path / verb | out of scope, read-only write | `AuthorizationService` |
| Quota | over limit | `QuotaService` |
| Owner | wrong `user_id` | Postgres RLS |

RLS (`user_id = current_setting('app.user_id')`) does not enforce path scope or liveness. It applies only when the app connects as the NOBYPASSRLS `app` role; the bundled compose connects as the `postgres` superuser, which bypasses RLS.

- Each request runs in `withUserTx(userId)`, which sets `app.user_id`; unset returns 0 rows.
- `withUserTx` returns a branded `WithinUserTx` (writes: `WithinUserWriteTx`), so repositories cannot use a bare `this.db` on RLS tables. Caller-owned txs (Better Auth hooks) use `wrapUserTxPoolClient`, which verifies `app.user_id`.
- `grant_paths` and `upload_session_chunks` join to their parent; `file_revisions` denormalizes `user_id`.
- Cron cannot run as `app` without a user: jobs list users from Better Auth `"user"` (outside RLS) and run `withUserTx` per user; failures are per-user.

## Invariants

- OAuth grants cannot be delegation parents; composite FKs keep a grant and its `parent_grant_id` on one user.
- `parent_grant_id` is `ON DELETE RESTRICT`: delete children first.
- An AFTER DELETE trigger on `oauth_grants` removes the parent `grants` row.
