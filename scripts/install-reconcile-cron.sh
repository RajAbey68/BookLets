#!/bin/bash
# Idempotent crontab installer for the daily Ko Lake reconciliation.
# Run ONCE, manually, AFTER the PR is merged to main (the cron executes
# whatever is checked out in this working copy). Re-running is a no-op.
# Default schedule: 06:30 local time daily. Override: RECON_CRON="30 5 * * *"
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRAPPER="$REPO_DIR/scripts/reconcile-kolake.sh"
SCHEDULE="${RECON_CRON:-30 6 * * *}"
MARKER="# booklets-kolake-recon"

chmod +x "$WRAPPER"

CURRENT="$(crontab -l 2>/dev/null || true)"
if echo "$CURRENT" | grep -qF "$MARKER"; then
  echo "Cron entry already installed:"
  echo "$CURRENT" | grep -F "$MARKER"
  exit 0
fi

printf '%s\n%s %s %s\n' "$CURRENT" "$SCHEDULE" "$WRAPPER" "$MARKER" | crontab -
echo "Installed: $SCHEDULE $WRAPPER"
echo "Logs: ~/Library/Logs/booklets-recon.log"
