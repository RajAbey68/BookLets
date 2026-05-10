# Agent Coordination Log

This file is a lightweight lockboard for AI agents (Claude Code, Antigravity,
Gemini, etc.) working concurrently on this repo. Read it before starting work.
Update it when you start, hand off, or finish.

## Rules of engagement

1. **Never push directly to `main`.** Each agent works on a branch named
   `<vendor>/<short-purpose>` and opens a draft PR.
2. **Claim a scope below before editing.** If the files you need are listed
   under another agent's `Touching`, coordinate (or pick a different scope)
   instead of stepping on them.
3. **Rebase before each push.** Conflicts surface in your branch, not in
   someone else's working tree.
4. **Keep entries short.** Status, branch, files touched, expected duration.
   Remove your block when the PR merges.

## Active work

### Claude (claude/evidence-log-hashchain) — EvidenceLog hash chain (re-enable P1.5)
- **Started:** 2026-05-10
- **Goal:** Make `EvidenceLog` writes real: every `LedgerService.postEntry` /
  `reverseEntry` records an immutable, sha256-chained evidence row. Re-enable
  the P1.5 governance gate (`evidenceLog.create` + `sha256` greps in
  `.github/workflows/p1-governance.yml`).
- **Touching:**
  - `src/lib/evidence-log.service.ts` (new)
  - `src/lib/ledger.service.ts` (add hook into postEntry / reverseEntry)
  - `src/lib/types.ts` (only if a shared interface needs to move)
  - `.github/workflows/p1-governance.yml` (re-enable P1.5)
  - `prisma/seed.ts` (only if a genesis evidence row needs seeding — TBD)
- **NOT touching (free for other agents):**
  - All UI / components / pages
  - `src/lib/automation.service.ts`, `src/lib/revenue.service.ts`,
    `src/lib/hostaway.service.ts` (PR #2 / PR #3 territory)
  - Any money columns (`Booking.totalAmount`, `Expense.amount`, etc. —
    PR #4-equivalent Float→Decimal scope, claimed by lead coordinator)
- **Out of scope for this PR (followups):**
  - SoD enforcement (`makerIdentity !== checkerIdentity`) — needs auth/session
    first; will re-enable P1.4 in a separate PR.
  - Per-tenant serialisation of evidence writes (currently relies on Postgres
    transaction; concurrent writers could fork the chain — flagged as a
    known limitation, not blocking).

### Lead coordinator (claude/ui-and-page-wiring, PR #2) — UI/SSR/page-wiring
- See PR #2 description. Currently `dirty` post-PR-#1-merge; awaiting rebase.

### Other Claude session (claude/improve-process-handling-aaZJP, PR #3) — fetch timeouts + sync failure reporting
- See PR #3 description. Currently `dirty` post-PR-#1-merge; awaiting rebase.

## Recently completed

- **PR #1 (merged 2026-05-10, `main` @ a39b3e1)** — schema/services drift fix,
  Node 20 CI bump, ODA roadmap entry, AGENTS_LOG.md lockboard. Aligned
  Prisma schema with service code (renamed `Account.accountType→type`,
  `JournalLine.debitCredit→isDebit`, added `FiscalPeriod.isClosed`),
  added Suspense (9999) + chart-of-accounts codes to seed, moved Prisma
  7's `datasource.url` to `prisma.config.ts`, repointed CI greps from the
  non-existent `src/services/` to `src/lib/`.

## Roadmap (low priority)

### Objective-Driven Adoption (ODA) for agentic implementation

A methodology proposal raised by the human operator and independently
echoed by the Antigravity agent. Worth capturing here so the next pass
can fold it into the architecture.

**Premise.** TDD makes the *test* the contract: code is "done" when the
test goes green. ODA generalises that for agent-driven (BMAD-style) work
by making the *objective* the contract. An agent finishes when an
evaluator confirms the declared outcome — which can be a unit test, a
SQL invariant, a metric threshold, an LLM-graded rubric, or a human
4-eyes approval.

**Why it fits BookLets.** Two pieces of the schema are already
proto-ODA:
- `EvidenceLog` (immutable hash chain) — the green-test ledger.
- `ActionIntentQueue` (maker/checker/confidence) — the proposal queue.

Sketch of what would close the loop:
- `Objective` model: declarative goal (e.g. "trial balance == 0",
  "revenue recognised within 24h of checkout", "receipt confidence
  >= 0.9 ⇒ auto-post").
- `Evaluator`: deterministic check or graded judgement that scores an
  attempt against an objective.
- Runner: agents propose into `ActionIntentQueue`, evaluators score,
  `EvidenceLog` records pass/fail. Failed objectives drive retries or
  escalate to human-in-the-loop.

**Properties this buys.**
1. Termination — agents stop when the objective is met, not when
   tokens run out.
2. Regression safety — once-passed objectives become a lockfile.
3. Cost control — per-objective retry budgets; route hard cases to
   higher-tier models or humans.

**Adjacent prior art.** Outcome-based evals (Anthropic et al.),
MAPE-K loops in autonomic computing, ODD in autonomous-vehicle
spec, GA-style fitness functions.

**Status.** Not on the critical path. Pick up after the in-flight
followups (auth/session, Float→Decimal, EvidenceLog hash writes,
SoD enforcement) — those are prerequisites for a non-trivial
evaluator surface.

## Conventions for log entries

```
### <Agent> (<branch>) — <one-line goal>
- **Started:** YYYY-MM-DD
- **Goal:** ...
- **Touching:** bullet list of paths
- **NOT touching:** bullet list of paths you are explicitly leaving alone
- **Out of scope:** followups for whoever comes next
```
