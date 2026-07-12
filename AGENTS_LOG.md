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

### fable5-builder-s4 (claude/s4-conf-gate) — OCR confidence gate (defect D3): automated entries always DRAFT
- **Started:** 2026-07-12
- **Goal:** Close defect D3 (FABLE5 spec, service S4 "conf-gate" / M9):
  `AutomationService.processReceipt` auto-POSTed journal entries when OCR
  confidence exceeded 0.9. New named domain rule
  `gateAutomatedJournalEntry` (in `approval.service.ts`, the 4-eyes
  authority) makes every machine-extracted entry land as DRAFT — no
  confidence, including exactly 1.0, grants posting authority. The only
  DRAFT→POSTED path remains the human checker sign-off
  (`decideDraftJournalEntry`). Strict TDD: RED tests proved the 0.9
  auto-post, then GREEN.
- **Touching:**
  - `src/lib/approval.service.ts` (add `gateAutomatedJournalEntry` + result type)
  - `src/lib/automation.service.ts` (use the gate; result status always `HIL_REQUIRED`)
  - `src/components/ReceiptUploader.tsx` (copy: HIL message no longer claims a threshold)
  - `tests/unit/receipt-confidence-gate.test.ts` (new)
  - `AGENTS_LOG.md` (this entry)
- **NOT touching:**
  - `src/lib/ledger.service.ts` (`postEntry` still defaults to POSTED when
    `status` is omitted — see out of scope)
  - `src/lib/prisma.ts` SymbiOS integrity extension (gate composes with it,
    does not bypass it)
  - approval actions / 4-eyes flow (unchanged; it stays the sole promotion path)
- **Out of scope (followups):**
  - `LedgerService.postEntry` defaulting `status` to POSTED means a future
    call-site that forgets `status` silently auto-posts; consider requiring
    an explicit status (or defaulting to DRAFT) for maker identities that
    are agents.
  - The SymbiOS fallback path trusts the remote `extraction.confidence`
    without clamping; the gate now throws on out-of-contract values, but a
    friendlier degrade (clamp + DRAFT) could be argued.

### Claude — prime process-handling agent (claude/auth-google-oauth) — auth scaffold (Google OAuth + Vercel target)
- **Started:** 2026-05-13
- **Goal:** Scaffold Auth.js v5 with Google OAuth so the operator can let
  accountants and a bookkeeper sign in from remote locations. JWT
  sessions (no DB persistence of Account/Session tables to avoid
  collision with BookLets's chart-of-accounts `Account`). Foundation
  only — service-side refactor to use the session for `makerIdentity`
  and org resolution follows in a separate PR.
- **Touching:**
  - `prisma/schema.prisma` (add `User`, `Membership`; back-ref on `Organization`)
  - `src/auth.ts` (new — Auth.js v5 config with Google provider)
  - `src/app/api/auth/[...nextauth]/route.ts` (new — handlers)
  - `src/app/login/page.tsx` (new — sign-in page)
  - `middleware.ts` (new — route gate)
  - `src/app/page.tsx` (add `dynamic = "force-dynamic"`; was failing build because `getDefaultUploadContext` hits the DB at static prerender time)
  - `package.json`, `package-lock.json` (add `next-auth@beta`, `@auth/prisma-adapter`)
- **NOT touching:**
  - `src/lib/*` services — service refactor is the next PR
  - `src/app/actions/*` — same
  - schema beyond the two new models + back-ref
- **Out of scope (followups):**
  - Replace `prisma.organization.findFirst()` in `sync.actions.ts`,
    `automation.service.ts`, etc. with session-derived org via
    `Membership`.
  - Pass `session.user.id` as `makerIdentity` into
    `LedgerService.postEntry` and `AutomationService.processReceipt`
    (currently hardcoded as `'booklets-automation-service'`).
  - SoD enforcement (`makerIdentity !== checkerIdentity`) once
    real checker identities exist.
  - Membership admin UI (currently you attach users via direct SQL).

### Claude — prime process-handling agent (claude/release-readiness, PR #10) — Vercel/Neon deploy infra + seed wiring
- **Started:** 2026-05-10
- **Goal:** Seed config in the right Prisma 7 location, pg adapter on
  the seed client, package.json db scripts, Dockerfile hardening
  (`npm ci`, schema present at runtime), and a DEPLOY.md runbook that
  documents the Vercel + Neon + Google OAuth path as the recommended
  target. End-to-end verified locally against a native Postgres 16
  cluster (push → seed → build → start → sync produces balanced
  journal entries).
- **Touching:** `Dockerfile`, `docker-compose.yml`, `package.json`,
  `prisma.config.ts`, `prisma/seed.ts`, `DEPLOY.md`.
- **Status:** Ready for review.

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

### fable5-builder-s6 (claude/s6-review-ui) — DRAFT review queue with batch 4-eyes decisions
- **Started:** 2026-07-12
- **Agent:** fable5-builder-s6
- **Goal:** S6 review-ui — a review queue where a checker sees each DRAFT
  journal entry with its evidence side-by-side (extracted vendor/category
  via memo parsing, amount, date, agentConfidence, source/sourceId,
  heuristically matched Expense record, per-entry EvidenceLog trail) and
  can approve/reject many at once. Batch decisions fan out SEQUENTIALLY
  over the existing `decideDraftJournalEntry` path, so every 4-eyes
  control holds per entry: session-resolved checker identity (already
  real — `resolveActiveContext()`), `assertNotSelfApproval` (own drafts
  fail with a per-entry error, never silently approved), DRAFT-only
  state machine, guarded update + EvidenceLog in one transaction.
- **Touching:**
  - `src/app/actions/approval.actions.ts` (add `batchDecideDraftJournalEntries`, `fetchDraftReviewQueue`)
  - `src/lib/approval.service.ts` (add exported `isSameIdentity` helper)
  - `src/lib/draft-evidence.ts` (new — pure memo/source evidence parsing)
  - `src/components/DraftReviewQueue.tsx` (new — client queue with batch selection)
  - `src/app/(app)/approvals/page.tsx` (drafts table → `DraftReviewQueue`)
  - `tests/unit/batch-approval-actions.test.ts`, `tests/unit/draft-evidence.test.ts` (new)
- **NOT touching:**
  - `decideDraftJournalEntry` / `decideActionIntent` internals — batch is a caller, not a rewrite
  - `src/lib/ledger.service.ts`, `src/lib/evidence-log.service.ts`, schema
  - S5 zip-ingest files (`src/lib/zip-ingest*`, `src/app/api/ingest/zip/`)
- **Out of scope (followups):**
  - **Receipt image persistence.** Verified reality: receipt images are
    NOT stored anywhere. `Expense.receiptCloudId` exists in the schema
    but nothing writes it; `AutomationService.processReceipt` OCRs the
    base64 in-memory and discards it; S5 zip-ingest keeps only a sha256
    (`sourceId`). The review UI renders a clearly-typed placeholder slot
    that will light up once a stored reference exists. Follow-up: persist
    uploads to object storage, write `receiptCloudId`, add a viewer.
  - **Structured JournalEntry ↔ Expense link.** No FK exists; the queue
    matches heuristically (vendor + amount + same UTC day) and labels the
    match as heuristic. Follow-up: set `source='receipt-automation'`,
    `sourceId=<expense.id>` in `AutomationService` at creation time.
  - Pagination for large DRAFT queues (batch is capped at 50 per request).

### fable5-builder-s6 (claude/s6-review-ui, round 2) — dedicated /review page + sidebar badge
- **Started:** 2026-07-12
- **Agent:** fable5-builder-s6
- **Goal:** Finish S6 review-ui: a dedicated `/review` route (the queue
  previously only lived inside `/approvals`) plus a sidebar "Review" link
  with a server-computed DRAFT-count badge. No new approval machinery —
  the page reuses `fetchDraftReviewQueue` / `DraftReviewQueue` and all
  decisions still run through `decideDraftJournalEntry` /
  `batchDecideDraftJournalEntries` (4-eyes per entry, per-row batch
  isolation, checker = session user).
- **Touching:**
  - `src/app/(app)/review/page.tsx` (new — auth-gated by global middleware)
  - `src/app/actions/approval.actions.ts` (add `fetchDraftReviewCount`;
    cap `fetchDraftReviewQueue` at 100 newest-first with a `createdAt`
    tiebreaker; decisions also `revalidatePath('/review')`)
  - `src/components/Sidebar.tsx` (Review nav item + count badge),
    `src/components/AppShell.tsx`, `src/app/(app)/layout.tsx` (badge wiring)
  - `tests/unit/review-page-actions.test.ts` (new)
- **NOT touching:**
  - `decideDraftJournalEntry` / `batchDecideDraftJournalEntries` decision
    logic, `src/lib/approval.service.ts`, schema, `/approvals` page
- **Out of scope (followups):**
  - True pagination past the newest-100 cap (deciding entries surfaces
    the older remainder; fine at current volumes).
  - Live badge updates without navigation (would need client polling —
    deliberately skipped per S6 scope).

### Lead coordinator (claude/ui-and-page-wiring, PR #2) — UI/SSR/page-wiring
- **LANDED (2026-07-12 reconciliation):** the design-system CSS primitives
  this entry tracked are on `main` via `1e1b1b9` ("feat(ui): add
  design-system primitives, strip Tailwind from shell"). Do not treat this
  work as pending. Entry retained for history only.

### Lead coordinator (claude/float-to-decimal, PR #5) — Float → Decimal money columns
- **LANDED (2026-07-12 reconciliation):** Float→Decimal on all monetary
  fields is on `main` via `bdd8cff` (schema shows `Decimal(19,4)`
  throughout). Do not treat this work as pending. Entry retained for
  history only.

### fable5-builder-doc-drift (claude/fable5-doc-drift) — doc-drift reconciliation
- **Started:** 2026-07-12
- **Goal:** Conservative, factual doc corrections only (FABLE5 pre-Wave-0
  E5): fix the false "no automated tests" claim in
  `docs/BRIEFING_FOR_OTHER_SERVICES.md` (24 Vitest suites exist), annotate
  the stale `bbcf03b` baseline / PR #2 / PR #5 references, and mark
  RAJ-277…296 roadmap issues done in `ROADMAP.md` where git history proves
  a merge to `main`.
- **Touching:**
  - `docs/BRIEFING_FOR_OTHER_SERVICES.md`
  - `ROADMAP.md`
  - `AGENTS_LOG.md` (this entry)
- **NOT touching:** all source code, schema, CI workflows, tests.
- **Out of scope:** restructuring either doc; verifying Linear issue
  states in Linear itself; RAJ-277/278/280/293 (no git evidence — left
  open).

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
