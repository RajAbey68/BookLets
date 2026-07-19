#!/usr/bin/env bash
# RAJ-674 — end-to-end proof that backup-db.sh + restore-db.sh round-trip.
#
# Seeds a throwaway SOURCE Postgres with the real schema + known rows, backs it
# up, restores the dump into a SECOND throwaway, and asserts the row counts
# survived. Touches no real database. Run this in CI or by hand to keep the
# backup path trustworthy. Requires Docker + libpq (pg_dump/pg_restore/psql).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$ROOT"

PSQL="${PSQL:-/opt/homebrew/opt/libpq/bin/psql}"
SRC="booklets-backup-src-$$"; SRC_PORT=55491
cleanup() { docker rm -f "$SRC" >/dev/null 2>&1 || true; rm -f "$TMP_DUMP" 2>/dev/null || true; }
trap cleanup EXIT

echo "[dryrun] starting SOURCE Postgres…"
docker run -d --name "$SRC" -e POSTGRES_PASSWORD=src -e POSTGRES_DB=src -p "${SRC_PORT}:5432" postgres:16-alpine >/dev/null
for _ in $(seq 1 30); do docker exec "$SRC" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done

SRC_URL="postgresql://postgres:src@localhost:${SRC_PORT}/src"

echo "[dryrun] applying schema (prisma db push)…"
DATABASE_URL="$SRC_URL" npx prisma db push --accept-data-loss >/dev/null

echo "[dryrun] seeding known rows (1 org, 2 accounts)…"
"$PSQL" "$SRC_URL" -q -c "
  INSERT INTO \"Organization\" (id, name, slug, \"createdAt\", \"updatedAt\")
    VALUES ('org_dry', 'Dry Run Books', 'dry-run', now(), now());
  INSERT INTO \"Account\" (id, \"organizationId\", name, code, type, \"createdBy\", \"createdAt\", \"updatedAt\")
    VALUES ('acc_cash','org_dry','Operating Cash','1000','ASSET','dryrun',now(),now()),
           ('acc_rev','org_dry','Rental Income','4000','REVENUE','dryrun',now(),now());"

SRC_ORGS="$("$PSQL" "$SRC_URL" -At -c 'SELECT count(*) FROM "Organization";')"
SRC_ACCS="$("$PSQL" "$SRC_URL" -At -c 'SELECT count(*) FROM "Account";')"
echo "[dryrun] source has orgs=$SRC_ORGS accounts=$SRC_ACCS"

TMP_DUMP="$(mktemp -u).dump"
echo "[dryrun] backing up…"
BACKUP_DATABASE_URL="$SRC_URL" bash "$HERE/backup-db.sh" "$TMP_DUMP" >/dev/null

echo "[dryrun] restoring into a throwaway + reading counts…"
RESTORE_OUT="$(bash "$HERE/restore-db.sh" --verify-into-throwaway "$TMP_DUMP" 2>&1)"
echo "$RESTORE_OUT" | grep -E 'Organization|Account' || true

REST_ORGS="$(printf '%s' "$RESTORE_OUT" | awk '/Organization/{print $NF}')"
REST_ACCS="$(printf '%s' "$RESTORE_OUT" | awk '/^  Account /{print $NF}')"

if [[ "$REST_ORGS" == "$SRC_ORGS" && "$REST_ACCS" == "$SRC_ACCS" ]]; then
  echo "[dryrun] PASS — restored orgs=$REST_ORGS accounts=$REST_ACCS match source."
  exit 0
else
  echo "[dryrun] FAIL — restored orgs=$REST_ORGS accounts=$REST_ACCS != source orgs=$SRC_ORGS accounts=$SRC_ACCS" >&2
  exit 1
fi
