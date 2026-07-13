# Portfolio Agent Bus — design proposal (cross-project Hermes/Claude coordination)

> Status: DRAFT for Raj + Hermes review. Nothing in this doc has been built —
> no repo created, no code written. This is the design only, per Raj's
> instruction (2026-07-13): "just draft the design doc."

## 1. Problem

Raj runs 11 GitHub projects, developed via Claude (multiple IDEs/sessions)
and Hermes (Raj's local Mac / devserver agent). Today, coordination is
per-repo and ad hoc:

- BookLets has its own bus (`docs/runs/FABLE5-RUN-LOG.md`) that only this
  repo's sessions and Hermes read/write.
- There is no cross-repo channel. A Claude session working in one project
  has no way to know the state of, or request work from, another project or
  from Hermes-owned infra that isn't scoped to that one repo.
- The **Portfolio registry** referenced in `FABLE5-BUILD-SPEC.md` ("41 GitHub
  repos catalogued: description, live URL, stack, deploy status, CodeQL
  status, category, relationships") exists only in Raj's second-brain /
  Obsidian notes on his Mac — not machine-readable, not git-based. No
  automated session (Claude or Hermes) can query it directly; it's manually
  consulted or relayed by Raj.
- Raj-as-relay for anything requiring Hermes's judgment (per
  `FABLE5-BUILD-SPEC.md` §E3/E6 — Fable cannot SSH to devserver or dispatch
  non-Anthropic models directly) works for one project. It does not scale to
  eleven.

This was anticipated once already: `Message.md` (2026-05-16 entry) proposed
"per-repo bus PR (a) or central bus repo (b)? ... Promote to (b) only when
we're coordinating across ≥3 repos." Raj is now at 11 — well past that
threshold.

## 2. Proposed architecture

### 2.1 One new repo: the Portfolio Bus

A new, small repo (name TBD — e.g. `RajAbey68/agent-bus`,
`RajAbey68/hermes-bus`, or `RajAbey68/portfolio-control`) that is the ONE
place any Claude session (in any of the 11 project repos) or Hermes (which
runs independently of any single repo) posts and reads cross-project
messages and status.

**This does NOT replace each project's own local bus.** BookLets keeps
`docs/runs/FABLE5-RUN-LOG.md` for BookLets-internal coordination. The
portfolio bus repo is only for: (a) the portfolio registry itself, (b)
cross-project requests/status, (c) Hermes's single polling point instead of
eleven.

### 2.2 Contents

**`registry.json`** — one entry per project, the git-based promotion of the
second-brain portfolio registry (single source of truth both Hermes and any
Claude session can read via a normal clone/API call instead of manual
consultation):

```json
{
  "repo": "RajAbey68/BookLets",
  "description": "Property-management bookkeeping app",
  "stack": "Next.js16 / Prisma7 / Supabase / Vercel",
  "category": "finance",
  "deploy": { "status": "live", "url": "https://booklets-one.vercel.app" },
  "execution": { "devserver": true, "serverless": true, "ci": "github-actions" },
  "local_bus": "docs/runs/FABLE5-RUN-LOG.md",
  "relationships": ["raj_fin_track (shared Supabase project, EU-west-1)"]
}
```

A `registry.schema.json` keeps it machine-validated — a CI check fails if a
project entry is malformed or a known repo is missing.

**One GitHub Issue per project** (e.g. titled `[bus] BookLets`) — that
project's cross-repo inbox. Any session posts a comment there when it needs
something from another project or from Hermes-owned infra outside its own
repo's scope. Structured comment convention (from `Message.md`'s original
proposal):

```
@@bus
from: <session/repo>
to: hermes | <other-repo> | *
intent: request-action | inform | reply
ref: <PR/commit/issue>
@@end
<free markdown body>
```

### 2.3 Hermes's role

Hermes already boots via
`~/.hermes/profiles/rajabey68/scripts/boot-orient.sh` and consults a
portfolio registry + second-brain. The change: point that boot script at
this repo's `registry.json` as the canonical source (the second-brain copy
becomes a mirror/cache, not the source of truth) — one clone/pull instead of
eleven manual lookups. Hermes polls the bus repo's open `[bus]` issues on
each boot/cron tick — the existing weekly cron pattern (BookLets'
`run-sandbox-loader.sh`, Mon 06:00) is a template for extending this to also
drain the portfolio bus.

### 2.4 Claude/Fable's role

Any Claude Code session working in one of the 11 project repos gets this bus
repo added (`add_repo`) alongside its own project repo, so it can post/read
cross-project requests directly via the GitHub API — no Raj relay needed for
the mechanical posting. Raj is only needed for actual judgment calls, per the
Orchestrator/Best-Fit-Worker operating model already adopted in this repo's
`AGENTS.md`.

The external-LLM-quorum pattern built for BookLets tonight (Z.AI review +
RajAbeyBot approval, `.github/workflows/llm-quorum-review.yml`) generalizes
cleanly: build it once in the bus repo as a **reusable workflow**, and each
of the 11 projects calls it —
`uses: RajAbey68/agent-bus/.github/workflows/llm-quorum-review.yml@main` —
instead of rebuilding it 11 times.

## 3. Migration path (low-risk, incremental)

1. Create the bus repo empty, with just `registry.json` seeded from
   whatever the second-brain registry currently has. (Hermes/Raj populate
   this — a cloud Claude session has no visibility into the other 10 repos
   or the second-brain content needed to auto-generate it.)
2. Point Hermes's boot script at it (one-line Hermes-side change).
3. Add `[bus]` issues per project lazily, as cross-project coordination is
   actually needed — not all 11 upfront.
4. Migrate the Z.AI quorum workflow to a reusable workflow called from each
   project, starting with BookLets (already built and in review, PR #85).
5. Each project keeps its own local run-log/AGENTS.md; the central bus is
   additive, never a replacement.

## 4. Open decisions (Raj + Hermes)

- Repo name + visibility (likely private, since the registry may reference
  business-sensitive deploy/stack details across projects).
- Who creates it — a Claude session (reversible: `create_repository` +
  push, trivial to delete if unwanted) or Hermes.
- Hermes populates the initial `registry.json` — the 41-repo content lives
  in the second-brain, not anywhere a cloud session can read.
