#!/bin/bash
# Container entrypoint for the litmus suite. Mints a Bearer token via setup.ts, configures nginx as a
# Basic-Auth proxy that injects the token, then runs litmus against the
# proxy. Wrapped here so we can post-process litmus output before exit.
set -euo pipefail

# Intentional non-compliance with RFC 4918: directory MOVE with Overwrite:T returns 409 instead of overwriting,
# because we rejected the non-atomic delete+move fallback. Litmus has no
# subtest-skip flag, so we run everything and assert FAILs ⊆ this set.
EXPECTED_FAILS=(move move_coll)

TOKEN=$(pnpm exec tsx e2e/litmus/setup.ts)
echo "[litmus] token obtained"

AUTH_B64=$(echo -n "user:${TOKEN}" | base64 -w0)
cat > /etc/nginx/conf.d/litmus-proxy.conf <<EOF
server {
    listen 8080;
    location / {
        proxy_pass http://app:8888;
        proxy_set_header Host app:8888;
        proxy_set_header Authorization "Basic ${AUTH_B64}";
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }
}
EOF
rm -f /etc/nginx/sites-enabled/default
nginx
echo "[litmus] nginx proxy started, running tests..."

LOG=$(mktemp)
set +e
TESTS="${LITMUS_TESTS:-basic copymove}" litmus -k 'http://localhost:8080/dav/' user dummy 2>&1 | tee "$LOG"
LITMUS_EXIT=${PIPESTATUS[0]}
set -e

nginx -s quit

# Each FAIL line looks like:  ` 9. move..................  9. move.................. FAIL (...)`
# Match start-of-line `<num>. <name>` only (avoid grabbing the word "FAIL"
# that may appear inside a test's description body or in unrelated output).
mapfile -t FAILED < <(
  sed -nE 's/^[[:space:]]*[0-9]+\.[[:space:]]+([a-z_]+)\.+.*[[:space:]]FAIL([[:space:]]|$).*/\1/p' "$LOG" | sort -u
)

# If litmus reported failures but we couldn't parse any test names, bail
# loudly rather than silently treating the run as success.
if [ "$LITMUS_EXIT" -ne 0 ] && [ ${#FAILED[@]} -eq 0 ]; then
  echo "[litmus] litmus exited $LITMUS_EXIT but no FAIL lines parsed — possible output format change" >&2
  rm -f "$LOG"
  exit "$LITMUS_EXIT"
fi
rm -f "$LOG"

UNEXPECTED=()
for name in "${FAILED[@]}"; do
  matched=0
  for ok in "${EXPECTED_FAILS[@]}"; do
    [ "$name" = "$ok" ] && matched=1 && break
  done
  [ $matched -eq 0 ] && UNEXPECTED+=("$name")
done

if [ ${#UNEXPECTED[@]} -gt 0 ]; then
  echo
  echo "[litmus] unexpected failures: ${UNEXPECTED[*]}" >&2
  echo "[litmus] (allowlist: ${EXPECTED_FAILS[*]})" >&2
  exit 1
fi

if [ ${#FAILED[@]} -gt 0 ]; then
  echo
  echo "[litmus] expected failures (intentional): ${FAILED[*]}"
fi

exit 0
