#!/usr/bin/env bash
# agent-bus-discover.sh — print an advisory at session start about
# the agent coordination bus, if one is configured for this repo.
#
# Intended to be invoked from a SessionStart hook in
# ~/.claude/settings.json so that any Claude session arriving at this
# repo automatically learns:
#   1. that an agent bus exists
#   2. which PR number to subscribe to
#   3. the last N comments on the bus
#
# Does NOT subscribe — the agent must call
# mcp__github__subscribe_pr_activity itself. This is intentional:
# tools have permission gates, plain shell scripts shouldn't drive
# tool authorisation.

set -euo pipefail

# Bail quietly if not in a git repo.
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

# Fetch quietly so we have current refs to read.
git fetch origin --quiet 2>/dev/null || true

# Tail Message.md if it exists (legacy async channel — still useful
# during the transition off file-based comms).
if [[ -f Message.md ]]; then
  echo "--- Message.md tail (last 40 lines) ---"
  tail -n 40 Message.md
  echo
fi

# Resolve bus PR via .agent-bus.json if present.
bus_pr=""
if [[ -f .agent-bus.json ]]; then
  # Tolerant parse: no jq dependency required.
  bus_pr="$(grep -oE '"busPr"[[:space:]]*:[[:space:]]*[0-9]+' .agent-bus.json \
            | grep -oE '[0-9]+' | head -1 || true)"
fi

# Fallback: check whether the agent-bus branch exists on origin.
if [[ -z "$bus_pr" ]]; then
  if git ls-remote --heads origin agent-bus 2>/dev/null | grep -q agent-bus; then
    echo "--- agent bus ---"
    echo "Branch 'agent-bus' exists on origin but .agent-bus.json is missing."
    echo "Open PRs on this branch are the bus. Resolve the PR number with"
    echo "mcp__github__list_pull_requests (head=agent-bus, state=open) and"
    echo "subscribe via mcp__github__subscribe_pr_activity."
    echo
    exit 0
  fi
  # No bus configured for this repo — silent exit.
  exit 0
fi

echo "--- agent bus ---"
echo "Bus PR for this repo: #${bus_pr}"
echo "To join, call: mcp__github__subscribe_pr_activity(owner, repo, ${bus_pr})"
echo "Then post a capability declaration (see BUS.md)."
echo "Recent bus comments are not fetched here — query via"
echo "mcp__github__pull_request_read(method=get_comments, pullNumber=${bus_pr})"
echo "to read them before posting."
echo

# Surface the AGENTS_LOG.md lockboard if it exists.
if [[ -f AGENTS_LOG.md ]]; then
  echo "--- AGENTS_LOG.md (active claims) ---"
  awk '/^## Active work/{flag=1; next} /^## /{flag=0} flag' AGENTS_LOG.md \
    | head -60
  echo
fi
