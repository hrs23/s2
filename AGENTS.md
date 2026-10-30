# AGENTS.md

Public and self-contained: English only, made-up examples, no secrets, personal data, internal URLs or references to other repositories. Keep files minimal; no docs beyond README and this file.

## Development

Requires Node.js, pnpm (`corepack enable`), and Docker.

```sh
pnpm install
cp .dev.vars.example .dev.vars   # set AUTH_SECRET
docker compose -f compose.dev.yaml up -d
pnpm dev                         # migrate + serve on :8888
pnpm dev:fresh                   # reset DB and .dev/storage, then serve
pnpm db:new NAME                 # new migration
pnpm test                        # unit + integration
pnpm check                       # lint, types, coverage, build
pnpm test:e2e                    # Docker; also :webui :api :visual :litmus
pnpm test:e2e:visual:update      # then commit PNGs under e2e/visual/
```

Hooks: pre-commit runs `pnpm lint`, pre-push runs `pnpm test`.

## Rules

- Migrations are append-only. Never edit a released one; existing installs only run new files.
- A new table gets its RLS policy and `FORCE ROW LEVEL SECURITY` in the same migration.
- Never `TRUNCATE file_revisions`: its DELETE trigger queues storage GC. Use `DELETE FROM file_nodes WHERE ...`.
- Schema is `migrations/`, HTTP contracts are `openapi.yaml`.
