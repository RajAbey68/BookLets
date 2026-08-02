#!/usr/bin/env bash
# RAJ-674 — full logical backup of the BookLets production database.
#
# Both non-Anthropic reviewers (Qwen + Z.AI GLM, 2026-07-15) made a VERIFIED
# backup a hard precondition for the single-tenant go-live: an AI-authored
# migration that corrupts the ledger must be recoverable. This is the "take a
# backup" half; scripts/restore-db.sh is the "prove you can restore it" half.
# The round-trip is exercised end-to-end in scripts/backup-restore-dryrun.sh.
#
# Usage:
#   BACKUP_DATABASE_URL='postgresql://...:5432/postgres' ./scripts/backup-db.sh [outfile]
#
# CRITICAL — use the DIRECT/SESSION connection, NOT the pooler:
#   pg_dump needs a real session; Supabase's transaction pooler (port 6543,
#   pgbouncer) will fail or dump inconsistently. Use the direct connection
#   (Settings → Database → Connection string → URI, port 5432) as
#   BACKUP_DATABASE_URL. Do NOT reuse the app's pooled DATABASE_URL here.
#
#   Also: `schema=` is a Prisma-only URL parameter — libpq/pg_dump reject it
#   ("invalid URI query parameter"). This script strips it automatically.
set -euo pipefail

URL="${BACKUP_DATABASE_URL:-}"
if [[ -z "$URL" ]]; then
  echo "ERROR: set BACKUP_DATABASE_URL to the DIRECT (port 5432) connection string." >&2
  exit 2
fi

# Strip the Prisma-only ?schema= / &schema= parameter libpq cannot parse.
URL="$(printf '%s' "$URL" | sed -E 's/[?&]schema=[^&]*//')"

PG_DUMP="${PG_DUMP:-/opt/homebrew/opt/libpq/bin/pg_dump}"
command -v "$PG_DUMP" >/dev/null 2>&1 || { echo "ERROR: pg_dump not found at $PG_DUMP (set PG_DUMP)." >&2; exit 3; }

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${1:-backups/booklets-${TS}.dump}"
mkdir -p "$(dirname "$OUT")"

echo "[backup-db] dumping to $OUT (custom format, compressed)…"
# -Fc  custom format → restorable with pg_restore, compressed, parallel-capable
# --no-owner / --no-privileges → portable across roles (Supabase role differs)
"$PG_DUMP" "$URL" -Fc --no-owner --no-privileges -f "$OUT"

BYTES="$(wc -c < "$OUT" | tr -d ' ')"
if [[ "$BYTES" -lt 1000 ]]; then
  echo "[backup-db] WARNING: dump is only ${BYTES} bytes — verify it is not empty/truncated." >&2
fi

echo "[backup-db] done: $OUT (${BYTES} bytes)"
echo "[backup-db] verify before trusting it: ./scripts/restore-db.sh --verify-into-throwaway $OUT"
