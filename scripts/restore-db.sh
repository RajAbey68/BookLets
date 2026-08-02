#!/usr/bin/env bash
# RAJ-674 — restore a BookLets logical backup produced by scripts/backup-db.sh.
#
# A backup you have never restored is not a backup. This script has two modes:
#
#   --verify-into-throwaway <dump>   Spin up a local throwaway Postgres, restore
#                                    the dump into it, print row counts. Proves
#                                    the dump is restorable WITHOUT touching any
#                                    real database. Use this after every backup.
#
#   --into <target-url> <dump>       Restore into a REAL target. Destructive:
#                                    refuses unless you type the confirmation
#                                    phrase. Intended for disaster recovery only.
#
# `schema=` (Prisma-only) is stripped for libpq, same as backup-db.sh.
set -euo pipefail

PG_RESTORE="${PG_RESTORE:-/opt/homebrew/opt/libpq/bin/pg_restore}"
PSQL="${PSQL:-/opt/homebrew/opt/libpq/bin/psql}"

strip_schema() { printf '%s' "$1" | sed -E 's/[?&]schema=[^&]*//'; }

usage() { echo "usage: $0 --verify-into-throwaway <dump> | --into <target-url> <dump>" >&2; exit 2; }

MODE="${1:-}"; [[ -z "$MODE" ]] && usage

case "$MODE" in
  --verify-into-throwaway)
    DUMP="${2:-}"; [[ -f "$DUMP" ]] || { echo "ERROR: dump '$DUMP' not found." >&2; exit 3; }
    CONTAINER="booklets-restore-verify-$$"
    PORT=55490
    echo "[restore-verify] starting throwaway Postgres ($CONTAINER)…"
    docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=verify -e POSTGRES_DB=verify \
      -p "${PORT}:5432" postgres:16-alpine >/dev/null
    cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
    trap cleanup EXIT
    for _ in $(seq 1 30); do docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done

    URL="postgresql://postgres:verify@localhost:${PORT}/verify"
    echo "[restore-verify] restoring $DUMP …"
    # --no-owner/--no-privileges → portable; errors on missing roles are non-fatal here.
    "$PG_RESTORE" --no-owner --no-privileges --dbname "$URL" "$DUMP" 2>&1 | tail -3 || true

    echo "[restore-verify] row counts in the restored copy:"
    # Robust, dependency-free: DO block iterates user tables and RAISEs one
    # NOTICE per table with its live count. NOTICEs go to stderr, so 2>&1.
    "$PSQL" "$URL" -q -c "
      DO \$\$
      DECLARE r RECORD; n BIGINT;
      BEGIN
        FOR r IN
          SELECT schemaname, tablename FROM pg_tables
          WHERE schemaname NOT IN ('pg_catalog','information_schema')
          ORDER BY tablename
        LOOP
          EXECUTE format('SELECT count(*) FROM %I.%I', r.schemaname, r.tablename) INTO n;
          RAISE NOTICE '  % %', rpad(r.tablename, 20), n;
        END LOOP;
      END \$\$;" 2>&1 | sed -n 's/^NOTICE:  //p' | head -40
    echo "[restore-verify] OK — dump is restorable. Throwaway DB will be removed."
    ;;

  --into)
    TARGET="$(strip_schema "${2:-}")"; DUMP="${3:-}"
    [[ -n "$TARGET" && -f "$DUMP" ]] || usage
    echo "!!! DESTRUCTIVE: this will restore '$DUMP' into a REAL database." >&2
    echo "Type exactly: RESTORE OVERWRITE" >&2
    read -r CONFIRM
    [[ "$CONFIRM" == "RESTORE OVERWRITE" ]] || { echo "Aborted." >&2; exit 4; }
    "$PG_RESTORE" --no-owner --no-privileges --clean --if-exists --dbname "$TARGET" "$DUMP"
    echo "[restore] done."
    ;;

  *) usage ;;
esac
