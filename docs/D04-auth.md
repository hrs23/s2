# Authentication

## S2 account

Email + password; passkey and TOTP are optional. No social login, no email-change UI. The `pnpm user` CLI creates users and resets passwords.

Sign-up, passkey, TOTP, and email flags: [README](../README.md#self-host).

- Without `EMAIL_ENABLED`, signup does not prove email ownership.
- New users get all limits at 0 (unlimited): [D06-limits.md](D06-limits.md).
- `session` table is the session source of truth; secondary storage holds only rate limits and may be cleared.
- Better Auth hooks: `user.create.before` (signup gate), `user.create.after` (idempotently seeds `user_limits`, `user_storage`, Default token), `session.create.after` (`last_sign_in_at`).

## OAuth server

OAuth 2.1 for delegating a folder + permission to MCP and other apps ([D03-permissions.md](D03-permissions.md)).

1. `POST /oauth/register` (DCR)
2. `GET /oauth/authorize` (login + consent)
3. `POST /oauth/token` (code + PKCE)

- Access token 1h; refresh token 30d sliding, rotated, stored hashed.
- Refresh reuse revokes the family; a 30s grace window tolerates retries.
- Tokens carry an audience resource (e.g. `https://s2.example.com/mcp`).
- Redirect URIs: HTTPS, or HTTP on `localhost` / `127.0.0.1`.
