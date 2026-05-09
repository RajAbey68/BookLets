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
- **Out of scope (followups, anyone can pick up):**
  - Convert `Float` money columns (`Booking.totalAmount`, `Expense.amount`,
    `BookingCharge.amount`, `GuestPayout.amount`, `OwnerStatement.totalDue`)
    to `Decimal(19, 4)` — needs migration + decimal.js plumbing.
  - Real auth/session and multi-tenant `organizationId` resolution (currently
    hardcoded as `primary_org`).
  - Wire `EvidenceLog` writes + sha256 hash chain in `LedgerService`
    (re-enable P1.5 in `.github/workflows/p1-governance.yml` once landed).
  - Enforce Segregation of Duties (`makerIdentity !== checkerIdentity`) in
    `RevenueService` / `LedgerService` once session/auth identity exists
    (re-enable P1.4 in `.github/workflows/p1-governance.yml` once landed).
  - Replace hardcoded `organizationId="org_123"` / `propertyId="prop_abc"`
    in `src/app/page.tsx`.
  - Install Tailwind (or strip Tailwind classnames from components) and define
    `.glass-card` and other DESIGN.md primitives.
  - Fix `ReceiptUploader.tsx` SSR-unsafe `document.createElement` and move
    `AutomationService` behind a server action.

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
