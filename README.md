# S2

![S2](public/brand/product.svg)

Self-hosted, path-scoped storage for personal data, exposed via web UI, REST, WebDAV, OAuth, and MCP.
Files are stored as plaintext at rest. There is no S3-compatible API.

[Docs](docs/README.md) | [Contributing](CONTRIBUTING.md) | [MIT License](LICENSE)

## Self-host

Two containers (app, Postgres) from `ghcr.io/hrs23/s2`. The app listens on `127.0.0.1:${S2_PORT:-3000}`; put a TLS proxy in front.

```sh
mkdir s2 && cd s2
curl -fsSLO https://raw.githubusercontent.com/hrs23/s2/main/compose.yaml
curl -fsSL https://raw.githubusercontent.com/hrs23/s2/main/.env.example -o .env
```

Edit `.env`: set `AUTH_SECRET` and `POSTGRES_PASSWORD` (`openssl rand -hex 32`) and `APP_URL`.

```sh
docker compose up -d
curl --fail http://127.0.0.1:3000/health
docker compose exec app pnpm user create --email owner@example.com
```

### Update

```sh
docker compose pull && docker compose up -d
```

Set `S2_VERSION` in `.env` to pin a release (default `latest`). Migrations run on startup. Back up first.

### Reset password

```sh
docker compose exec app pnpm user set-password --email owner@example.com
```

### Backup

Stop the stack and copy `./data` (`POSTGRES_DATA_PATH` and `S2_STORAGE_PATH`) together.

### Flags

| Variable | Default | Effect |
|---|---|---|
| `SIGNUP_ENABLED` | `false` | Self-service sign-up |
| `PASSKEY_ENABLED` | `true` | Passkeys |
| `TOTP_ENABLED` | `true` | TOTP and recovery codes |
| `EMAIL_ENABLED` | `false` | Email verification and password reset; needs `SMTP_HOST`, `SMTP_FROM` (optional `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`) |

### Maintenance

Runs daily in the app (`MAINTENANCE_ENABLED=true`, `MAINTENANCE_CRON="0 17 * * *"`, UTC). One-shot:

```sh
docker compose exec app pnpm maintenance
```
