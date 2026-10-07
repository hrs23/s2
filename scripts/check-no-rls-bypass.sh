#!/usr/bin/env bash
# Forbid the two patterns that would re-open an RLS bypass behind the
# WithinUserTx / WithinUserWriteTx brand.
#
# 1. `<anything>?: ?? this.db` — the silent fallback the phantom-typed brand
#    was introduced to eliminate. The pattern is matched loosely (any variable
#    name, optional whitespace around `??` / `.`) so a rename can't sneak it
#    back in.
# 2. `as WithinUserTx` / `as WithinUserWriteTx` casts outside `app/lib/db/`
#    or `app/test/`. The brand is intended to be produced only by
#    `withUserTx` / `withUserWriteTx` / `wrapUserTxPoolClient` in `app/lib/db/`,
#    or by `asTestTx` in `app/test/` (integration tests run against PGlite as
#    a superuser, so the brand is a pure type-level marker there).
#
# Invoked from `package.json` as `pnpm check:rls-bypass`.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fail=0

# 1. `?? this.db` fallback in production code. `app/test/` is the only
#    allowlisted directory — test fixtures may legitimately reach for the
#    pre-tx client.
if grep -rnE --include="*.ts" --include="*.tsx" \
      '\?\?[[:space:]]*this[[:space:]]*\.[[:space:]]*db\b' app/ 2>/dev/null \
    | grep -vE '^app/test/' ; then
  echo "ERROR: forbidden '?? this.db' silent fallback survived."
  echo "RLS repositories must require WithinUserTx / WithinUserWriteTx."
  fail=1
fi

# 2. `as WithinUserTx` / `as WithinUserWriteTx` outside app/lib/db/ and app/test/.
if grep -rnE --include="*.ts" --include="*.tsx" \
      'as WithinUser(Tx|WriteTx)\b' app/ 2>/dev/null \
    | grep -vE '^app/lib/db/' \
    | grep -vE '^app/test/' ; then
  echo "ERROR: direct 'as WithinUserTx' / 'as WithinUserWriteTx' cast outside app/lib/db/."
  echo "Brand values must come from withUserTx / withUserWriteTx / wrapUserTxPoolClient."
  fail=1
fi

exit "$fail"
