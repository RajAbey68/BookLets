#!/bin/bash
# Cron wrapper for the Ko Lake reconciliation pilot.
# Pulls the DeepSeek key from the macOS Keychain at run time (service
# "deepseek-api") — the key never lands in a file or in crontab. Logs to
# ~/Library/Logs/booklets-recon.log with a timestamp per run.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="${HOME}/Library/Logs/booklets-recon.log"

# Keychain lookup is best-effort: without the key the run still executes,
# ambiguous rows simply stay exceptions (deterministic-first by design).
DEEPSEEK_API_KEY="$(security find-generic-password -s deepseek-api -w 2>/dev/null || true)"
export DEEPSEEK_API_KEY

{
  echo "=== recon run $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  cd "$REPO_DIR"
  npx tsx scripts/reconcile-kolake.ts
} >> "$LOG_FILE" 2>&1
