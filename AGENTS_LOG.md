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

1. **PR sequencing.** The agreed merge order is:
   1. PR #1 — schema/services drift (in flight).
   2. PR #2 — UI primitives + ReceiptUploader server action + page wiring
      (rebases on PR #1 once it lands; CI goes green after the rebase
      because PR #1 fixes the Node-18 / `src/services` path drift that
      breaks both workflows on `main`).
   3. **Float → Decimal money columns** — Opus 4.7 will pick this up
      immediately after PR #1 lands (it was blocked on PR #1's schema
      edits).
   4. **EvidenceLog hash-chain writes + SoD enforcement** — depends on
      real auth/session (#5).
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

### Claude (claude/review-booklets-code-YSiGa) — schema/services drift
- **Started:** 2026-05-09
- **Goal:** Align Prisma schema with service code so the app actually compiles
  and seeds. Fix CI grep paths. No UI/CSS/Tailwind changes in this pass.
- **Touching:**
  - `prisma/schema.prisma`
  - `prisma/seed.ts`
  - `src/lib/prisma.ts`
  - `src/lib/ledger.service.ts`
  - `src/lib/revenue.service.ts`
  - `src/lib/metrics.service.ts`
  - `src/lib/automation.service.ts`
  - `src/app/actions/*.ts` (read-mostly; only if a field rename leaks through)
  - `.github/workflows/p0-blockers.yml`
  - `.github/workflows/p1-governance.yml`
- **NOT touching (free for other agents):**
  - `src/components/**` (Tailwind / glass-card / ReceiptUploader SSR fix)
  - `src/app/globals.css`, `src/app/layout.tsx`, `src/app/page.tsx`
  - `src/app/bookings/page.tsx`, `src/app/properties/page.tsx`,
    `src/app/ledger/page.tsx`
  - `Dockerfile`, `docker-compose.yml`, `cloudbuild.yaml`, `next.config.ts`

### Claude (claude/ui-and-page-wiring) — UI primitives, SSR fix, page wiring
- **Started:** 2026-05-10
- **Goal:** Pick up three followups left behind by the schema PR: strip
  Tailwind classnames and define design-system primitives in `globals.css`;
  fix `ReceiptUploader` SSR-unsafe `document.createElement` and move
  `AutomationService` behind a new server action; resolve hardcoded
  `org_123` / `prop_abc` in `page.tsx` via a DB lookup against the seeded
  `primary_org`. One PR, three commits.
- **Touching:**
  - `src/app/globals.css`
  - `src/app/page.tsx`
  - `src/components/ReceiptUploader.tsx`
  - `src/components/AppShell.tsx`
  - `src/components/AppHeader.tsx`
  - `src/app/actions/receipt.actions.ts` (new file — no overlap with the
    existing `*.actions.ts` files the schema PR may touch)
  - `AGENTS_LOG.md` (this file)
- **NOT touching:**
  - Anything in the schema PR's "Touching" list above. If a field rename
    in PR #1 leaks into `page.tsx` after PR #1 merges, that's a rebase
    fix, out of scope here.
  - `src/lib/automation.service.ts` interface stays as-is; the new server
    action just wraps it.

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

(none)

## Conventions for log entries

```
### <Agent> (<branch>) — <one-line goal>
- **Started:** YYYY-MM-DD
- **Goal:** ...
- **Touching:** bullet list of paths
- **NOT touching:** bullet list of paths you are explicitly leaving alone
- **Out of scope:** followups for whoever comes next
```
