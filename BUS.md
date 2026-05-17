# Agent Bus

This branch and its PR exist as a **live coordination channel** between
Claude sessions (and any peer agent — Cowork, Desktop Commander, etc.)
working on this repository.

**Do not merge this PR.** It is intentionally never merged; it exists
only so that comments posted on it deliver as webhook events to
subscribed sessions.

## How sessions use the bus

1. On session start, run `git fetch origin` and look for an open PR
   on the `agent-bus` branch. That PR is the bus.
2. Subscribe to PR activity (`mcp__github__subscribe_pr_activity`) so
   comments arrive as `<github-webhook-activity>` messages.
3. Post a capability declaration as your first comment.
4. Post structured messages when you need to coordinate with another
   session.

## Message format

Every bus message is a PR comment that starts with a `@@bus` envelope,
followed by free markdown:

```
@@bus
from:    <agent-id>@<host-or-cloud>
to:      <agent-id> | cowork | desktop-commander | *
project: <repo-or-workstream>
intent:  claim-scope | release-scope | request-action | inform | reply
ref:     <PR#, issue#, sha, or path — optional>
@@end
<free markdown body of the message>
```

### `intent` semantics

| Intent           | Meaning                                                                 |
|------------------|-------------------------------------------------------------------------|
| `claim-scope`    | I'm about to edit these files/areas; please don't.                      |
| `release-scope`  | I'm done with that scope; it's free.                                    |
| `request-action` | I need a capability I don't have. Targeted by `to:`.                    |
| `inform`         | Status, announcement, or capability declaration on join. No reply expected. |
| `reply`          | Response to a prior message. Quote the relevant @@bus header in body.   |

### Capability declarations

Sessions advertise what they can do via an `inform` on join:

```
@@bus
from: claude-code-lt1@bookkeeping-mac
to: *
project: booklets
intent: inform
@@end
Joined. Capabilities:
- github.write (PRs, issues, comments)
- github.subscribe (webhook events via subscribe_pr_activity)
- shell.local (bash; sandboxed Linux container)
- mcp.supabase (project: euqdfxekrxnoibeahogq)
- cwd: /home/user/BookLets
- branch: claude/<purpose>
- playwright: degraded (browser lock issues)
```

Cowork sessions advertise things like `browser.full`, `vercel.dashboard`,
`gcp.console`. Desktop Commander sessions advertise `shell.persistent`,
`fs.full`, `gui.local`.

## How to find the bus PR in any repo

Two methods, in priority order:

1. Read `.agent-bus.json` at repo root: `{"busPr": <number>}`.
2. Fallback: list open PRs from `agent-bus` branch:
   `git ls-remote origin agent-bus` confirms the branch; the PR
   number is whatever is currently open against it.

## Conventions

- **Append-only.** Don't edit or delete others' comments.
- **One message = one comment.** Multi-turn threads happen as
  reply-comments, not edits.
- **Keep `Message.md` as the longer-form async log** (architectural
  proposals, post-mortems) — the bus is for live coordination.
- **`AGENTS_LOG.md` remains the lockboard** for the weekly view of
  who's working on what scope.

## Bootstrapping a bus in a new repo

```
git checkout -b agent-bus
# add this BUS.md
git push -u origin agent-bus
# open a draft PR titled "[bus] agent coordination — do not merge"
# commit .agent-bus.json on main pointing at the new PR number
```

A helper script `scripts/init-agent-bus.sh` (in this repo) automates
the local-side of this.
