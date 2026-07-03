# BookLets v1 — Full Roadmap (Linear-Backed)

> **Source of truth:** Linear project [BookLets v1 — Make It Accounting](https://linear.app/rajasimov-ai/project/booklets-v1-make-it-accounting-010a28810139)
> **Docs:** AKOS/BookLets/{FRD,IARD,GO_LIVE_SEQUENCE}.md
> **20 issues** across 2 phases, all in Backlog state

---

## PHASE 0: Foundation — Prerequisites (6 issues)
> Execute these first. Without them, Phase 1 will fight env/deploy/DB issues.

| # | ID | Priority | Title | Est. |
|---|----|----------|-------|------|
| 1 | **RAJ-277** | 🔴 | Vercel Pro + Custom Domain Setup | 0.5d |
| 2 | **RAJ-278** | 🔴 | Supabase Pro Upgrade + RLS Audit | 1d |
| 3 | **RAJ-279** | 🟡 | CI Pipeline Hardening | 1d |
| 4 | **RAJ-280** | 🔴 | Environment Variable Audit | 0.5d |
| 5 | **RAJ-281** | 🔴 | Database Indexes | 0.5d |
| 6 | **RAJ-282** | 🔴 | Fiscal Period DB Trigger | 1d |

**Gate:**
```
✅ Vercel Pro + custom domain resolving
✅ Supabase on Pro, connection verified
✅ CI passes with coverage ≥ 80%
✅ No hardcoded values in code (SYMBIOS_URL, HOSTAWAY_* all env vars)
✅ 6 partial indexes applied to Postgres
✅ DB trigger enforces closed-period blocking
```

---

## PHASE 1: Core Accounting — Ship-Blocking (14 issues)
> These turn BookLets from a transaction log into an accounting system.

### Tier 1: Schema + Data Integrity (must land before UI work)

| # | ID | Priority | Title | Depends On | Est. |
|---|----|----------|-------|------------|------|
| 7 | **RAJ-283** | 🟡 | Account Hierarchy Model (parentId rollup) | Phase 0 | 2d |
| 8 | **RAJ-284** | 🔴 | Idempotency Key on JournalEntry | Phase 0 | 1d |
| 9 | **RAJ-285** | 🟡 | Optimistic Locking (version field) | Phase 0 | 0.5d |

### Tier 2: User-Facing Features (the product)

| # | ID | Priority | Title | Depends On | Est. |
|---|----|----------|-------|------------|------|
| 10 | **RAJ-286** | 🔴 | Manual Journal Entry UI | 7, 8, 9 | 2d |
| 11 | **RAJ-287** | 🔴 | Fix Manual Booking → POST to Ledger | 8 | 1d |
| 12 | **RAJ-288** | 🔴 | Trial Balance Report Page | 10 | 2d |
| 13 | **RAJ-289** | 🔴 | P&L Statement with Account Rollup | 7, 12 | 3d |
| 14 | **RAJ-290** | 🔴 | Balance Sheet | 13 | 2d |
| 15 | **RAJ-291** | 🔴 | Dashboard Drill-Down | 12 | 2d |
| 16 | **RAJ-292** | 🟡 | 4-Eyes Approval Workflow UI | 10 | 3d |

### Tier 3: Security Hardening (non-negotiable for multi-tenant)

| # | ID | Priority | Title | Depends On | Est. |
|---|----|----------|-------|------------|------|
| 17 | **RAJ-293** | 🔴 | RLS on All Tables | Phase 0 | 2d |
| 18 | **RAJ-294** | 🟡 | 4-Eyes: No Self-Approval Enforcement | 16 | 0.5d |
| 19 | **RAJ-295** | 🟡 | Block POSTED Entry Deletion at DB Level | Phase 0 | 0.5d |

### Tier 4: Quality

| # | ID | Priority | Title | Depends On | Est. |
|---|----|----------|-------|------------|------|
| 20 | **RAJ-296** | 🔴 | Integration Tests for Journal Posting | 10 | 1d |

**Exit Criteria:**
```
✅ Can create a manual journal entry → appears in GL
✅ Manual booking appears in P&L (no more phantom revenue)
✅ Trial balance = €0.00
✅ P&L shows revenue/expenses with correct rollup
✅ Balance sheet: assets = liabilities + equity
✅ Dashboard metrics clickable → underlying entries shown
✅ RLS verified: org A cannot see org B's data
✅ 4-eyes: approver != maker enforced
✅ Closed fiscal period rejected at DB level
✅ All 20 tests pass
```

---

## Execution Order

```
Week 1           Week 2           Week 3
┌──────────┐    ┌──────────┐    ┌──────────┐
│ P0-01─06  │    │ P1-04─06  │    │ P1-09─13  │
│ (foundation)│   │ (entry UI,│   │ (drill-down,│
│           │    │  booking fix,│  │  4-eyes, RLS)│
│ P1-01─03  │    │  trial bal) │   │           │
│ (schema)   │    │           │    │ P1-T      │
└──────────┘    │ P1-07─08  │    │ (tests)    │
                │ (P&L, BS)  │    └──────────┘
                └──────────┘
```

---

## What To Hand To Claude Code

```
Read AKOS/BookLets/FRD_BOOKLETS.md and AKOS/BookLets/IARD_BOOKLETS.md.
Read the full BookLets codebase.

Phase 0 is done (env vars, indexes, triggers, CI).
Start executing Phase 1 in order:
  RAJ-283 → RAJ-284 → RAJ-285 → RAJ-286 → RAJ-287 → RAJ-288 → RAJ-289 → RAJ-290 → RAJ-291 → RAJ-292 → RAJ-293 → RAJ-294 → RAJ-295 → RAJ-296

Implement using TDD. Mark Linear issues Done as you complete them.
```
