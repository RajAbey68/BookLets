# Agent Coordination Log

This file is a lightweight lockboard for AI agents (Claude Code, Antigravity,
Gemini, etc.) working concurrently on this repo. Read it before starting work.
Update it when you start, hand off, or finish.

## Coordination lead

**Claude (Opus 4.7)** is the lead coordinator for BookLets development
going forward. Active session: `claude/ui-and-page-wiring` (PR #2).

This does **not** interrupt any in-flight work. The schema/services PR
(`claude/review-booklets-code-YSiGa` / PR #1) continues unchanged and
merges on its own merit — its scope was claimed first and that priority
stands.

What "lead" means here:

1. **PR sequencing.** Updated 2026-05-10 (post-PR-#3 discovery). The
   merge order is now:
   1. **PR #2** (`claude/ui-and-page-wiring`) — combined UI primitives
      + ReceiptUploader server action + page wiring + schema/services
      drift + CI bump. Awaiting CI verdict.
   2. **PR #3** (`claude/improve-process-handling-aaZJP`) — fetch
      timeouts + per-record failure reporting in the Hostaway/SymbiOS
      sync path. Started from `main` (pre-PR-#2 base); needs to rebase
      onto PR #2's tip because it touches three service files
      (`automation`, `hostaway`, `revenue`) that PR #2 already renamed
      fields in. Net-additive otherwise — no schema changes.
   3. **Float → Decimal money columns** — Opus 4.7 picks this up after
      PR #3 lands. Now blocked on PR #3 (same three service files) in
      addition to the original PR #2 dependency.
   4. **EvidenceLog hash-chain writes + SoD enforcement** — depends on
      real auth/session (#5). Re-enables P1.4 / P1.5 once landed.
   5. **Real auth/session + multi-tenant `organizationId` resolution.**
   6. **WhatToDo integration** (Baileys / Railway). **Do not re-develop.**

2. **Scope claims.** Before starting a new branch, add an "Active work"
   block in the existing format and check that no other agent's
   `Touching` list overlaps. If it does, ping the lead here (or open a
   draft PR with `[blocked: coord-required]` in the title) and the
   sequencing will be resolved before you start coding.

3. **Architectural decisions.** Roadmap calls (e.g., "Tailwind yes/no",
   "auth provider", "queue infra for HIL", "WhatToDo contract shape")
   land in a `## Decisions` section in this file as they're made, with
   the date and the agent who proposed.

4. **Shared-file conflict policy.** `AGENTS_LOG.md`, `prisma/schema.prisma`,
   `prisma/seed.ts`, and `package.json` are guaranteed conflict-prone.
   Rebase early, rebase often. If a conflict needs adjudication, the
   lead will resolve.

If you're an agent reading this and disagree with anything above,
propose the change in a draft PR against this file. Coordination should
be observable and version-controlled, not implicit.

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

### Claude (claude/improve-process-handling-aaZJP) — process-handling improvements (PR #3)
- **Started:** 2026-05-10 (other station, before lead lockboard updates
  were visible — block recorded retroactively by lead)
- **Goal:** Add fetch timeouts (`AbortSignal`) for Hostaway + SymbiOS
  external calls and convert silent per-record sync failures into a
  typed `ManualSyncResult` / `SyncReport` with `partial` semantics.
  Net-additive; no schema, UI, or governance changes.
- **Touching:**
  - `src/lib/http.ts` (new — `fetchWithTimeout`, `FetchTimeoutError`)
  - `src/lib/hostaway.service.ts`
  - `src/lib/automation.service.ts`
  - `src/lib/revenue.service.ts`
  - `src/app/actions/sync.actions.ts`
- **Sequencing note (lead):** branch is based on `main` pre-PR-#2.
  Three of the four touched `src/lib/*.ts` files were renamed/edited in
  PR #2's cherry-picked schema alignment. PR #3 should rebase onto PR
  #2's tip (`origin/claude/ui-and-page-wiring`) before final review;
  conflicts are mechanical (field renames, no semantic overlap).

### Claude Opus 4.7 (claude/ui-and-page-wiring) — combined PR #2
- **Started:** 2026-05-10 (UI work) / **expanded:** 2026-05-10 (lead pivot
  pulled in schema/services drift + CI bump)
- **Goal:** Land a single coherent PR covering UI primitives,
  ReceiptUploader SSR fix + server action, page wiring, schema/services
  drift alignment, and CI Node-20 bump — the full "must-fix" pre-#3
  baseline.
- **Touching:**
  - `src/app/globals.css`, `src/app/page.tsx`
  - `src/components/ReceiptUploader.tsx`, `src/components/AppShell.tsx`,
    `src/components/AppHeader.tsx`
  - `src/app/actions/receipt.actions.ts`,
    `src/app/actions/context.actions.ts` (new files)
  - `prisma/schema.prisma`, `prisma/seed.ts`
  - `src/lib/automation.service.ts`, `src/lib/ledger.service.ts`,
    `src/lib/revenue.service.ts`
  - `scripts/seed-ledger.ts`, `scripts/test-hostaway-sync.ts`
  - `.github/workflows/p0-blockers.yml`, `.github/workflows/p1-governance.yml`
  - `AGENTS_LOG.md` (this file)
- **NOT touching:**
  - `src/lib/metrics.service.ts`, `src/lib/hostaway.service.ts`,
    `src/lib/prisma.ts` (untouched; will revisit only if Float→Decimal
    requires it).
  - `Dockerfile`, `docker-compose.yml`, `cloudbuild.yaml`,
    `next.config.ts`.

## Out of scope (followups, anyone can pick up)

- Convert `Float` money columns (`Booking.totalAmount`, `Expense.amount`,
  `BookingCharge.amount`, `GuestPayout.amount`, `OwnerStatement.totalDue`)
  to `Decimal(19, 4)` — needs migration + decimal.js plumbing.
  **Blocked until PR #1 (`claude/review-booklets-code-YSiGa`) lands** to
  avoid edit-conflicts on `prisma/schema.prisma` and the services.
- Real auth/session and multi-tenant `organizationId` resolution (currently
  hardcoded as `primary_org`).
- Wire `EvidenceLog` writes + sha256 hash chain in `LedgerService`
  (re-enable P1.5 in `.github/workflows/p1-governance.yml` once landed).
- Enforce Segregation of Duties (`makerIdentity !== checkerIdentity`) in
  `RevenueService` / `LedgerService` once session/auth identity exists
  (re-enable P1.4 in `.github/workflows/p1-governance.yml` once landed).
- Integrate **WhatToDo** — existing shared service for WhatsApp-driven task
  management (Baileys runtime, hosted on Railway). **Do not re-develop.**
  Likely surface area: a `lib/whattodo.client.ts` HTTP wrapper + env vars
  for the Railway base URL and shared secret, then wire into the HIL
  approval flow (notify checker on `ActionIntentQueue` PENDING items,
  accept approve/reject callbacks). Confirm contract with WhatToDo owner
  before coding.

## Recently completed

### Claude (claude/review-booklets-code-YSiGa) — schema/services drift
- **Status:** Absorbed into PR #2 by lead pivot 2026-05-10. Both
  substantive commits (`0732ea7`, `dcae4d9`) cherry-picked with
  authorship preserved (`-x` reference). PR #1 should be closed; the
  branch can be deleted after PR #2 merges.

## Conventions for log entries

```
### <Agent> (<branch>) — <one-line goal>
- **Started:** YYYY-MM-DD
- **Goal:** ...
- **Touching:** bullet list of paths
- **NOT touching:** bullet list of paths you are explicitly leaving alone
- **Out of scope:** followups for whoever comes next
```
