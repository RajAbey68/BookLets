# Agent Coordination Log

This file is a lightweight lockboard for AI agents (Claude Code, Antigravity,
Gemini, etc.) working concurrently on this repo. Read it before starting work.
Update it when you start, hand off, or finish.

## Read me first

Operational charter for this repo: [`docs/BRIEFING_FOR_OTHER_SERVICES.md`](docs/BRIEFING_FOR_OTHER_SERVICES.md).
That document is the source of truth for canonical IDs, write surfaces,
non-negotiable rules, deprecated paths, and access model. Every agent
joining this repo should read it before claiming scope here.

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

### Claude — prime process-handling agent (claude/agent-briefing) — operational briefing for BookLets
- **Started:** 2026-05-10
- **Goal:** Produce `docs/BRIEFING_FOR_OTHER_SERVICES.md` as the operational
  charter for cross-agent coordination, modelled on the Skool MCP briefing
  pattern. Refresh this lockboard for the current `main` state.
- **Touching:**
  - `docs/BRIEFING_FOR_OTHER_SERVICES.md` (new)
  - `AGENTS_LOG.md` (this file: move merged PRs to Recently completed,
    add upstream context, claim scope)
- **NOT touching:** all source code, schema, CI workflows.

### Lead coordinator (claude/ui-and-page-wiring, PR #2) — UI/SSR/page-wiring
- See PR #2 description. Rebased on `main`. Build is no longer blocked
  on this PR (PR #8 carved out the `ReceiptUploader → server action`
  commit with attribution); PR #2 still owns the design-system CSS
  primitives and page-wiring commits. Held in draft for human visual
  signoff per PR #2's own test plan.

### Lead coordinator (claude/float-to-decimal, PR #5) — Float → Decimal money columns
- See PR #5 description. Draft. Rebased on `main` after PR #3 + PR #8
  landed. No further conflicts expected.

## Recently completed

- **PR #8 (merged 2026-05-10, `main` @ bbcf03b)** — Carve-out from PR #2:
  `ReceiptUploader` moved to `processReceiptAction` server action,
  removing Prisma from the client bundle; SSR-unsafe `document.createElement`
  removed; Tailwind classes replaced with design-system primitives that
  PR #2's CSS commit will define. Also widened `EvidenceLogClient` args
  from `unknown` to `any` to fix a contravariance regression at the
  Prisma callsite. `npm run build` now passes end-to-end.
- **PR #7 (merged 2026-05-10, `main` @ d8809e9)** — `force-dynamic` on
  `/ledger` and `/properties` so the build does not query Postgres at
  static prerender time.
- **PR #6 (merged 2026-05-10, `main` @ 5cacd56)** — Prisma 7 client
  factory now wires `@prisma/adapter-pg` driver adapter; resolves the
  `PrismaClientConstructorValidationError` at runtime; `tsc --noEmit`
  reports 0 errors.
- **PR #4 (merged 2026-05-10, `main` @ c52ed8a)** — `EvidenceLogService`
  with sha256 hash chain (per-tenant, chained via `previousHash`).
  Hooks into `LedgerService.postEntry` (`JOURNAL_POSTED` event) and
  `reverseEntry` (`JOURNAL_REVERSED` event). Re-enabled P1.5 governance
  gate in CI.
- **PR #3 (merged 2026-05-10, `main` @ efc8d88, 5 commits)** — Fetch
  timeouts (`fetchWithTimeout`) + retry with jittered backoff
  (`fetchWithRetry`) in `src/lib/http.ts`; single-flight Hostaway OAuth
  token refresh; `SyncReport` per-record failure aggregation;
  `triggerManualSync` returns typed `ManualSyncResult` with `partial`
  state; pre-flight property+org validation in `AutomationService`;
  richer SymbiOS error responses.
- **PR #1 (merged 2026-05-10, `main` @ a39b3e1)** — Schema/services
  drift fix, Node 20 CI bump, ODA roadmap entry, AGENTS_LOG.md
  lockboard. Aligned Prisma schema with service code (renamed
  `Account.accountType→type`, `JournalLine.debitCredit→isDebit`, added
  `FiscalPeriod.isClosed`), added Suspense (9999) + chart-of-accounts
  codes to seed, moved Prisma 7's `datasource.url` to
  `prisma.config.ts`, repointed CI greps from the non-existent
  `src/services/` to `src/lib/`.

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
followups (auth/session, Float→Decimal, SoD enforcement) — those are
prerequisites for a non-trivial evaluator surface.

### Agent-scope-guard CI workflow

A pre-merge check that fails any PR touching files outside its
`AGENTS_LOG.md` claim, converting the lockboard from a polite convention
into an enforced contract. Sketch in
[`docs/BRIEFING_FOR_OTHER_SERVICES.md`](docs/BRIEFING_FOR_OTHER_SERVICES.md)
backlog.

## Conventions for log entries

```
### <Agent> (<branch>) — <one-line goal>
- **Started:** YYYY-MM-DD
- **Goal:** ...
- **Touching:** bullet list of paths
- **NOT touching:** bullet list of paths you are explicitly leaving alone
- **Out of scope:** followups for whoever comes next
```
