#!/usr/bin/env bash
# RAJ-674 Tier 1 — provision an ephemeral Postgres for the real-DB
# integration lane, matching production's structure:
#   1. prisma db push       — creates the current schema.prisma tables
#   2. raw-SQL migrations   — applies the two migrations Prisma cannot
#      express (fiscal-lock/posted-delete triggers, RLS policies)
#
# Idempotent: safe to re-run against an already-running container.
set -euo pipefail

CONTAINER_NAME="booklets-test-pg"
PG_PORT="55432"
export DATABASE_URL="postgresql://postgres:test@localhost:${PG_PORT}/booklets_test"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

if ! docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  echo "[test-integration-setup] starting $CONTAINER_NAME..."
  docker run -d --name "$CONTAINER_NAME" \
    -e POSTGRES_PASSWORD=test -e POSTGRES_DB=booklets_test \
    -p "${PG_PORT}:5432" postgres:16-alpine >/dev/null
else
  docker start "$CONTAINER_NAME" >/dev/null 2>&1 || true
fi

echo "[test-integration-setup] waiting for Postgres to accept connections..."
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER_NAME" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "[test-integration-setup] resetting schema..."
docker exec "$CONTAINER_NAME" psql -U postgres -d booklets_test \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null

echo "[test-integration-setup] prisma db push (schema baseline)..."
npx prisma db push --accept-data-loss >/dev/null

echo "[test-integration-setup] applying raw-SQL migrations (triggers, RLS, single-tenant lock)..."
docker exec -i "$CONTAINER_NAME" psql -U postgres -d booklets_test \
  < prisma/migrations/20260703_fiscal_lock_and_posted_delete_triggers/migration.sql >/dev/null
docker exec -i "$CONTAINER_NAME" psql -U postgres -d booklets_test \
  < prisma/migrations/20260712_rls_org_isolation/migration.sql >/dev/null
docker exec -i "$CONTAINER_NAME" psql -U postgres -d booklets_test \
  < prisma/migrations/20260716_single_tenant_lock/migration.sql >/dev/null

echo "[test-integration-setup] ready: $DATABASE_URL"
