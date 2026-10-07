#!/bin/bash
# Run an E2E service and extract artifacts to the host via docker cp.
# Avoids bind mounts so output files are always owned by the calling user.
#
# Usage: e2e/docker/run.sh <project> <service> [args...]
set -euo pipefail

# Append git branch name so concurrent runs from different worktrees don't conflict
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/' '-' | tr '[:upper:]' '[:lower:]')
PROJECT="${1}-${BRANCH}"
SERVICE="${2}"
shift 2

COMPOSE="docker compose -p ${PROJECT} -f e2e/docker/compose.yml"

# Run without --rm so the stopped container is available for docker cp afterward
set +e
${COMPOSE} run --build "${SERVICE}" "$@"
EXIT_CODE=$?
set -e

# Extract artifacts (best-effort — not every service produces them)
CONTAINER=$(docker ps -aqf "label=com.docker.compose.project=${PROJECT}" \
                         -f "label=com.docker.compose.service=${SERVICE}" | head -1)

if [ -n "${CONTAINER}" ]; then
  docker cp "${CONTAINER}:/app/e2e/playwright-report" ./e2e/playwright-report 2>/dev/null || true
  docker cp "${CONTAINER}:/app/e2e/test-results" ./e2e/test-results 2>/dev/null || true
  docker cp "${CONTAINER}:/app/e2e/visual/." ./e2e/visual 2>/dev/null || true
  docker rm "${CONTAINER}" > /dev/null
fi

# Stop containers, clean volumes/networks, and remove the built image too.
# BuildKit's layer cache is kept independently so the next `--build` is still
# fast (only changed layers re-execute). Removing the tagged image prevents
# accumulation of `s2-e2e-*-<branch>` images across worktrees, which otherwise
# pile up in Docker.raw and trigger ENOSPC.
${COMPOSE} down -v --rmi local

exit ${EXIT_CODE}
