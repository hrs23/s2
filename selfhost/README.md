# Self-Host

Two containers (app, Postgres). The app listens on `127.0.0.1:${S2_PORT:-3000}`; put a TLS proxy in front.
Commands below assume:

```sh
alias s2c='docker compose --env-file selfhost/.env -f selfhost/compose.yaml'
```

## Configure

```sh
cp selfhost/.env.example selfhost/.env   # set AUTH_SECRET, POSTGRES_PASSWORD (openssl rand -hex 32), APP_URL
```

## Start

```sh
s2c up -d --build
curl --fail http://127.0.0.1:3000/health
```

## Create first user

```sh
s2c run --rm app pnpm selfhost:user create --email owner@example.com
```

## Reset password

```sh
s2c run --rm app pnpm selfhost:user set-password --email owner@example.com
```

## Upgrade

```sh
git fetch --tags && git checkout <tag>
s2c build --pull app && s2c up -d
```

Back up first. Migrations run on startup.

## Backup

Back up `POSTGRES_DATA_PATH` and `S2_STORAGE_PATH` (default `selfhost/data/{postgres,storage}`) together.

## Flags

| Variable | Default | Effect |
|---|---|---|
| `SIGNUP_ENABLED` | `false` | Self-service sign-up |
| `PASSKEY_ENABLED` | `true` | Passkeys |
| `TOTP_ENABLED` | `true` | TOTP and recovery codes |
| `EMAIL_ENABLED` | `false` | Email verification and password reset; needs `SMTP_HOST`, `SMTP_FROM` (optional `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`) |

## Limits

- Row-level security is not active: the app connects as the `postgres` superuser.
- Behind a reverse proxy, rate limits count the proxy address, not each client.
- REST and WebDAV `PUT` buffer the whole body in memory; use chunked uploads for large files.

## Maintenance

Runs daily in the app (`MAINTENANCE_ENABLED=true`, `MAINTENANCE_CRON="0 17 * * *"`, UTC). One-shot:

```sh
s2c run --rm app pnpm selfhost:maintenance
```
