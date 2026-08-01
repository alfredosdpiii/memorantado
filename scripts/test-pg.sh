#!/usr/bin/env bash
# Runs the full vitest suite against a throwaway Postgres + pgvector
# container (docker-compose.pg.yml, port 55432).
set -euo pipefail

cd "$(dirname "$0")/.."

export MEMORANTADO_STORE=pg
export MEMORANTADO_DATABASE_URL="${MEMORANTADO_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:55432/memorantado}"

cleanup() {
  docker compose -f docker-compose.pg.yml down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker compose -f docker-compose.pg.yml up -d --wait

npx vitest run "$@"
