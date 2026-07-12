# ADVERSARIAL REVIEW BRIEF — Checkpoint PRE-W0 (doc-drift) — PR #72

## Your role
Independent adversarial reviewer (Layer 1). Docs-only change; the risk is FALSE
CORRECTIONS — marking something done that didn't land, or deleting a true claim.

## Claims to attack
1. tests/unit/ contains 24 Vitest suites (the briefing claimed zero).
2. Every ROADMAP issue marked done cites a commit SHA that is an ancestor of
   origin/main and actually contains that issue's work (spot-check at least
   RAJ-289 via commit 859f3de and RAJ-291 via 8c96102).
3. RAJ-277, 278, 280, 293 are correctly left open (no git evidence exists).
4. Nothing factual was deleted rather than annotated/struck-through.

## Verdict format (reply exactly)
VERDICT: PASS | BLOCK
checkerIdentity: <your model name/version>
FINDINGS: <numbered list>

## Full diff (origin/main...claude/fable5-doc-drift)
```diff
diff --git a/AGENTS_LOG.md b/AGENTS_LOG.md
index 3b53ec1..d712b2d 100644
--- a/AGENTS_LOG.md
+++ b/AGENTS_LOG.md
@@ -91,6 +91,23 @@ joining this repo should read it before claiming scope here.
 - See PR #5 description. Draft. Rebased on `main` after PR #3 + PR #8
   landed. No further conflicts expected.
 
+### fable5-builder-doc-drift (claude/fable5-doc-drift) — doc-drift reconciliation
+- **Started:** 2026-07-12
+- **Goal:** Conservative, factual doc corrections only (FABLE5 pre-Wave-0
+  E5): fix the false "no automated tests" claim in
+  `docs/BRIEFING_FOR_OTHER_SERVICES.md` (24 Vitest suites exist), annotate
+  the stale `bbcf03b` baseline / PR #2 / PR #5 references, and mark
+  RAJ-277…296 roadmap issues done in `ROADMAP.md` where git history proves
+  a merge to `main`.
+- **Touching:**
+  - `docs/BRIEFING_FOR_OTHER_SERVICES.md`
+  - `ROADMAP.md`
+  - `AGENTS_LOG.md` (this entry)
+- **NOT touching:** all source code, schema, CI workflows, tests.
+- **Out of scope:** restructuring either doc; verifying Linear issue
+  states in Linear itself; RAJ-277/278/280/293 (no git evidence — left
+  open).
+
 ## Recently completed
 
 - **PR #8 (merged 2026-05-10, `main` @ bbcf03b)** — Carve-out from PR #2:
diff --git a/ROADMAP.md b/ROADMAP.md
index 12e312f..ac1a1b6 100644
--- a/ROADMAP.md
+++ b/ROADMAP.md
@@ -2,7 +2,8 @@
 
 > **Source of truth:** Linear project [BookLets v1 — Make It Accounting](https://linear.app/rajasimov-ai/project/booklets-v1-make-it-accounting-010a28810139)
 > **Docs:** AKOS/BookLets/{FRD,IARD,GO_LIVE_SEQUENCE}.md
-> **20 issues** across 2 phases, all in Backlog state
+> **20 issues** across 2 phases, ~~all in Backlog state~~
+> **Status update (2026-07-12):** 16 of 20 issues have verifiably merged to `main` — marked ✅ Done below with the merge/landing commit as evidence (`git log --all --grep=<issue>`). RAJ-277, RAJ-278, RAJ-280, RAJ-293 have no landing evidence in git history and remain open.
 
 ---
 
@@ -13,10 +14,10 @@
 |---|----|----------|-------|------|
 | 1 | **RAJ-277** | 🔴 | Vercel Pro + Custom Domain Setup | 0.5d |
 | 2 | **RAJ-278** | 🔴 | Supabase Pro Upgrade + RLS Audit | 1d |
-| 3 | **RAJ-279** | 🟡 | CI Pipeline Hardening | 1d |
+| 3 | **RAJ-279** | 🟡 | CI Pipeline Hardening — ✅ Done (`30700c8`) | 1d |
 | 4 | **RAJ-280** | 🔴 | Environment Variable Audit | 0.5d |
-| 5 | **RAJ-281** | 🔴 | Database Indexes | 0.5d |
-| 6 | **RAJ-282** | 🔴 | Fiscal Period DB Trigger | 1d |
+| 5 | **RAJ-281** | 🔴 | Database Indexes — ✅ Done (`de6121e`, #52) | 0.5d |
+| 6 | **RAJ-282** | 🔴 | Fiscal Period DB Trigger — ✅ Done (`03ff97d`, #54) | 1d |
 
 **Gate:**
 ```
@@ -37,35 +38,35 @@
 
 | # | ID | Priority | Title | Depends On | Est. |
 |---|----|----------|-------|------------|------|
-| 7 | **RAJ-283** | 🟡 | Account Hierarchy Model (parentId rollup) | Phase 0 | 2d |
-| 8 | **RAJ-284** | 🔴 | Idempotency Key on JournalEntry | Phase 0 | 1d |
-| 9 | **RAJ-285** | 🟡 | Optimistic Locking (version field) | Phase 0 | 0.5d |
+| 7 | **RAJ-283** | 🟡 | Account Hierarchy Model (parentId rollup) — ✅ Done (`c1d8177`) | Phase 0 | 2d |
+| 8 | **RAJ-284** | 🔴 | Idempotency Key on JournalEntry — ✅ Done (`c1d8177`) | Phase 0 | 1d |
+| 9 | **RAJ-285** | 🟡 | Optimistic Locking (version field) — ✅ Done (`c1d8177`) | Phase 0 | 0.5d |
 
 ### Tier 2: User-Facing Features (the product)
 
 | # | ID | Priority | Title | Depends On | Est. |
 |---|----|----------|-------|------------|------|
-| 10 | **RAJ-286** | 🔴 | Manual Journal Entry UI | 7, 8, 9 | 2d |
-| 11 | **RAJ-287** | 🔴 | Fix Manual Booking → POST to Ledger | 8 | 1d |
-| 12 | **RAJ-288** | 🔴 | Trial Balance Report Page | 10 | 2d |
-| 13 | **RAJ-289** | 🔴 | P&L Statement with Account Rollup | 7, 12 | 3d |
-| 14 | **RAJ-290** | 🔴 | Balance Sheet | 13 | 2d |
-| 15 | **RAJ-291** | 🔴 | Dashboard Drill-Down | 12 | 2d |
-| 16 | **RAJ-292** | 🟡 | 4-Eyes Approval Workflow UI | 10 | 3d |
+| 10 | **RAJ-286** | 🔴 | Manual Journal Entry UI — ✅ Done (`71d6c15`) | 7, 8, 9 | 2d |
+| 11 | **RAJ-287** | 🔴 | Fix Manual Booking → POST to Ledger — ✅ Done (`e8df4a2`) | 8 | 1d |
+| 12 | **RAJ-288** | 🔴 | Trial Balance Report Page — ✅ Done (`55d5723`) | 10 | 2d |
+| 13 | **RAJ-289** | 🔴 | P&L Statement with Account Rollup — ✅ Done (landed inside `859f3de`, #50, which absorbed #58) | 7, 12 | 3d |
+| 14 | **RAJ-290** | 🔴 | Balance Sheet — ✅ Done (`f5c6820`, #62) | 13 | 2d |
+| 15 | **RAJ-291** | 🔴 | Dashboard Drill-Down — ✅ Done (`8c96102`, #56) | 12 | 2d |
+| 16 | **RAJ-292** | 🟡 | 4-Eyes Approval Workflow UI — ✅ Done (`02d7a89`, #60) | 10 | 3d |
 
 ### Tier 3: Security Hardening (non-negotiable for multi-tenant)
 
 | # | ID | Priority | Title | Depends On | Est. |
 |---|----|----------|-------|------------|------|
 | 17 | **RAJ-293** | 🔴 | RLS on All Tables | Phase 0 | 2d |
-| 18 | **RAJ-294** | 🟡 | 4-Eyes: No Self-Approval Enforcement | 16 | 0.5d |
-| 19 | **RAJ-295** | 🟡 | Block POSTED Entry Deletion at DB Level | Phase 0 | 0.5d |
+| 18 | **RAJ-294** | 🟡 | 4-Eyes: No Self-Approval Enforcement — ✅ Done (`02d7a89`, #60) | 16 | 0.5d |
+| 19 | **RAJ-295** | 🟡 | Block POSTED Entry Deletion at DB Level — ✅ Done (`03ff97d`, #54) | Phase 0 | 0.5d |
 
 ### Tier 4: Quality
 
 | # | ID | Priority | Title | Depends On | Est. |
 |---|----|----------|-------|------------|------|
-| 20 | **RAJ-296** | 🔴 | Integration Tests for Journal Posting | 10 | 1d |
+| 20 | **RAJ-296** | 🔴 | Integration Tests for Journal Posting — ✅ Done (`62807c5`, #57) | 10 | 1d |
 
 **Exit Criteria:**
 ```
diff --git a/docs/BRIEFING_FOR_OTHER_SERVICES.md b/docs/BRIEFING_FOR_OTHER_SERVICES.md
index 8bea598..9ea2ad7 100644
--- a/docs/BRIEFING_FOR_OTHER_SERVICES.md
+++ b/docs/BRIEFING_FOR_OTHER_SERVICES.md
@@ -36,7 +36,7 @@ Plus two infrastructure modules:
 | Channels (ids) | `channel_airbnb`, `channel_booking.com`, `channel_direct` |
 | Fiscal period id | `fp_<year>` (auto-seeded for current year, `isClosed: false`) |
 | Database URL config | `prisma.config.ts` (Prisma 7 dropped `datasource.url` from `schema.prisma`) |
-| Money precision | `Decimal(19, 4)` on `JournalLine.amount`; other money columns tracked for migration in PR #5 |
+| Money precision | `Decimal(19, 4)` on all money columns (`JournalLine.amount`, `Booking.totalAmount`, `Expense.amount`, `BookingCharge.amount`, `GuestPayout.amount`, `OwnerStatement.totalDue`) since commit `bdd8cff` |
 | High-value journal threshold | `HIGH_VALUE_THRESHOLD = 10000` EUR (auto-DRAFT above) |
 | Default currency | EUR |
 
@@ -52,10 +52,10 @@ Plus two infrastructure modules:
 3. **Closed fiscal periods are sealed.** No write into a FiscalPeriod with
    `isClosed: true`. Enforced in the `prisma` extension at create and update.
 4. **No zero-amount lines** on POSTED entries.
-5. **Money precision.** `JournalLine.amount` is `Decimal(19, 4)` — never
-   round-trip through JS `number`. Other money columns (`Booking.totalAmount`,
-   `Expense.amount`, `BookingCharge.amount`, `GuestPayout.amount`,
-   `OwnerStatement.totalDue`) are tracked for migration in PR #5.
+5. **Money precision.** All money columns (`JournalLine.amount`,
+   `Booking.totalAmount`, `Expense.amount`, `BookingCharge.amount`,
+   `GuestPayout.amount`, `OwnerStatement.totalDue`) are `Decimal(19, 4)`
+   since commit `bdd8cff` — never round-trip through JS `number`.
 6. **Every ledger write is audited.** `LedgerService.postEntry` and
    `LedgerService.reverseEntry` write an `EvidenceLog` row inside the same
    transaction. Hash chain is per `tenantId` (organization). Don't bypass
@@ -179,7 +179,7 @@ For arbitrary journal entries from agent code:
 
 | File / Pattern | Replacement | Why |
 |---|---|---|
-| Tailwind classnames in components (`className="hidden lg:flex"`, `bg-blue-500/10`, `animate-pulse`, etc.) | DESIGN.md primitives once PR #2 lands (`.glass-card`, `.btn-primary`, `.is-analyzing`, `.lg-only-flex`) | No Tailwind installed; classes are dead. |
+| Tailwind classnames in components (`className="hidden lg:flex"`, `bg-blue-500/10`, `animate-pulse`, etc.) | Design-system primitives in `src/app/globals.css` (`.glass-card`, `.btn-primary`, `.is-analyzing`, `.lg-only-flex`) — landed in commit `1e1b1b9` | No Tailwind installed; classes are dead. |
 | Raw `fetch()` in services | `fetchWithTimeout` / `fetchWithRetry` from `src/lib/http.ts` | No timeouts → server-action stalls. |
 | Hardcoded FK strings (`'SUSPENSE_ACC_ID'`, `'PRIMARY_BANK_ACC_ID'`, `'channel_gen_001'`) | Resolve from seed by code/name | These never matched real DB rows. |
 | `try { await LedgerService.postEntry(...) } catch (err) { console.error... }` swallowing errors in sync paths | Let errors propagate; aggregate in `SyncReport.failures` | Silent partial failure was the original bug. |
@@ -191,6 +191,13 @@ For arbitrary journal entries from agent code:
 
 ## Current Baseline (as of `main @ bbcf03b`)
 
+> **Drift note (2026-07-12):** this baseline snapshot dates from
+> 2026-05-10; `main` has since advanced (currently `38f1807`) with the
+> Phase 1 accounting work (see `ROADMAP.md`), the design-system CSS
+> (`1e1b1b9`), the Float→Decimal migration + Vitest bootstrap
+> (`bdd8cff`), and Gemini OCR integration. The bullets below remain true
+> unless struck through, but the PR #2 visual caveat is resolved.
+
 - Schema, services, and CI workflows are aligned (PR #1).
 - Node 20 + actions@v4 in CI workflows; `npm install` clean (PR #1).
 - EvidenceLog hash chain is live; every ledger post writes a chained row (PR #4).
@@ -202,7 +209,7 @@ For arbitrary journal entries from agent code:
 - `ReceiptUploader` is now a pure client component; receipt processing goes through the `processReceiptAction` server action so Prisma is no longer pulled into the browser bundle (PR #8).
 - CI gates: P0.1–P0.6, P1.1, P1.2, P1.3, P1.5 all passing. **P1.4 (SoD) explicitly disabled, tracked.**
 - `npm run build` **passes** end-to-end (PR #8).
-- **Visual caveat:** the `ReceiptUploader` references design-system class names (`.glass-card`, `.is-analyzing`, `.is-success`, `.is-hil`, `.btn-primary`, `.uploader-*`) that PR #2's CSS commit defines. Until PR #2 lands, the receipt component renders unstyled but functional. PR #2 is held in draft for human visual signoff per its test plan; this is an intentional, transient state.
+- ~~**Visual caveat:** the `ReceiptUploader` references design-system class names (`.glass-card`, `.is-analyzing`, `.is-success`, `.is-hil`, `.btn-primary`, `.uploader-*`) that PR #2's CSS commit defines. Until PR #2 lands, the receipt component renders unstyled but functional.~~ **Resolved:** the design-system CSS primitives landed in `src/app/globals.css` (commit `1e1b1b9`, 2026-05-10).
 
 ## Required Service Changes For Any New Agent
 
@@ -250,11 +257,15 @@ Required environment:
 
 - Real auth/session and per-request `organizationId` resolution.
 - SoD enforcement (`makerIdentity !== checkerIdentity`); re-enables P1.4.
-- Float → Decimal migration for remaining money columns (PR #5 in flight).
+- ~~Float → Decimal migration for remaining money columns (PR #5 in flight).~~
+  **Done:** all monetary fields are `Decimal(19, 4)` since commit `bdd8cff` (2026-05-13).
 - Owner statement generation, reconciliation, and payout export.
 - Multi-currency handling (currently EUR-only at the type level).
 - Mobile-app shape for `ReceiptUploader` (currently web only).
-- **Test infrastructure — there are no automated tests in the repo today.**
+- ~~Test infrastructure — there are no automated tests in the repo today.~~
+  **Done (2026-05-13, commit `bdd8cff` and onward):** the repo now has 24
+  Vitest suites under `tests/unit/`, run via `npm run test:unit`
+  (`vitest run`, config in `vitest.config.ts`).
 - Per-tenant serialisation of `EvidenceLog` writes (advisory lock or
   `SELECT … FOR UPDATE`) to prevent chain forking under concurrent writers.
 - An automated agent-scope-guard CI check that fails any PR touching
```
