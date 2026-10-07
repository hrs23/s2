# Architecture

## Layers

`Gateway -> Service -> Repository -> DbClient -> PostgreSQL`; Services also use AuthorizationService, QuotaService, and Storage.

| Layer | Code |
|---|---|
| Gateway | `app/routes/`, `app/lib/gateway/` |
| Service | `app/lib/*/*-service.server.ts` |
| Repository | `app/lib/*/*-repository.server.ts` |
| DbClient (RLS context) | `app/lib/db/` |
| Storage | `app/lib/storage/` |
| Maintenance (may call Repositories directly) | `app/lib/cron/` |

- Services return Result types; the gateway maps them to HTTP status. CAS failures in a transaction throw `TxRollbackError`, converted back to Result at the service boundary.
- AuthorizationService is the only policy decision point ([D03](D03-permissions.md)).
- No Service calls from Repositories, no SQL from Gateway, no filesystem APIs in Services.

## Runtime

Node app + PostgreSQL + filesystem ([README](../README.md#self-host)). Filesystem is the only storage backend. Migrations run before serving. Reverse proxy, TLS, and DNS are the operator's job. Local development: [CONTRIBUTING.md](../CONTRIBUTING.md).
