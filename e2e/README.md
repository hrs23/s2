# E2E tests

Tests run in Docker.

```sh
pnpm test:e2e          # all suites
pnpm test:e2e:webui    # UI
pnpm test:e2e:api      # API
pnpm test:e2e:visual   # visual regression
pnpm test:e2e:litmus   # WebDAV (litmus)
```

## Update snapshots

```sh
pnpm test:e2e:visual:update
```

Commit the changed PNGs under `e2e/visual/`.

## Artifacts

Copied to the host after each run: `e2e/playwright-report/` (HTML report) and
`e2e/test-results/` (screenshots, traces).
