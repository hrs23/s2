# Contributing

Requires Node.js, pnpm (`corepack enable`), and Docker.

```sh
pnpm install
cp .dev.vars.example .dev.vars   # set AUTH_SECRET
docker compose -f compose.dev.yaml up -d   # dev Postgres
pnpm dev                         # migrate + serve on :8888
pnpm dev:fresh                   # reset DB and .dev/storage, then serve
pnpm db:reset                    # reset DB only
pnpm db:new NAME                 # new migration
```

```sh
pnpm test       # unit + integration
pnpm check      # lint, types, coverage, build
pnpm test:e2e   # see e2e/README.md
```

Hooks: pre-commit runs `pnpm lint`, pre-push runs `pnpm test`.

## Migrations are append-only

Never edit a released migration; add a new one with `pnpm db:new NAME`. Existing installs only run new files on upgrade.

## Never `TRUNCATE file_revisions`

Its DELETE trigger queues storage GC; `TRUNCATE` skips it and orphans blobs. Use `DELETE FROM file_nodes WHERE ...`.
