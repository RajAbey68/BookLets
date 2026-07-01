# BookLets — Infrastructure & Architecture Requirements Document (IARD)

> **Version:** 1.0
> **Status:** Draft for Claude enhancement
> **Target Stack:** Vercel (hosting) + Supabase (database) + Google OAuth (auth) + SymbiOS (AI)

---

## 1. Current Architecture (As-Is)

```
┌──────────────┐     ┌───────────────────┐     ┌──────────────┐
│  Browser     │────▶│  Vercel (Edge)     │────▶│  Supabase    │
│  (React SPA) │     │  Next.js 19 SSR    │     │  PostgreSQL  │
└──────────────┘     │  Middleware (auth)  │     │  Schema:     │
                     │  API Routes        │     │  booklets    │
                     │  Server Components  │     └──────┬───────┘
                     └──────────┬─────────┘            │
                                │                      │
                     ┌──────────▼─────────┐            │
                     │  Hostaway PMS      │            │
                     │  REST API          │            │
                     └────────────────────┘            │
                                                       │
                     ┌──────────────────┐              │
                     │  SymbiOS Vision  │◀─────────────┘
                     │  Localhost:8080   │
                     └──────────────────┘
```

**Current deployment:**
- **Hosting:** Vercel (Hobby plan, `booklets-one.vercel.app`)
- **Database:** Supabase free tier (shared project, `booklets` schema)
- **Auth:** Auth.js v5 + Google OAuth + JWT sessions
- **AI:** SymbiOS service (hardcoded `localhost:8080` in code)
- **CI/CD:** GitHub Actions (build, typecheck, lint, CodeQL)
- **Agent Bus:** GitHub PR-based coordination (PR #32, `agent-bus` branch)

---

## 2. Target Architecture (To-Be)

```
┌──────────────────────────────────────────────────────────────────┐
│                    VERCEL (Pro / Team)                            │
│  ┌─────────────────────┐   ┌────────────────────────────┐        │
│  │ Edge Runtime         │   │ Serverless Functions        │        │
│  │ - Auth middleware     │   │ - API routes               │        │
│  │ - Redirects           │   │ - Server Actions           │        │
│  └─────────────────────┘   │ - Metadata API              │        │
│                            └────────────────────────────┘        │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Deployment Pipeline                                          │ │
│  │ GitHub → Vercel Git Integration → Build → Deploy to Preview │ │
│  │ → Promote to Production                                       │ │
│  └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
         │                            │
         │ HTTP                       │ Server Actions (Prisma)
         ▼                            ▼
┌──────────────────┐      ┌──────────────────────────────┐
│  Hostaway PMS     │      │  SUPABASE PRO                 │
│  (REST API v1)    │      │  ┌────────────────────────┐  │
│  OAuth2 client_creds│     │  │ PostgreSQL 15           │  │
└──────────────────┘      │  │ Schema: booklets         │  │
                          │  │ - RLS on every table     │  │
                          │  │ - Fiscal period triggers  │  │
                          │  │ - Partial indexes         │  │
                          │  └────────────────────────┘  │
                          │  ┌────────────────────────┐  │
                          │  │ Supabase Auth (Auth UI) │  │
                          │  │ - Google OAuth provider │  │
                          │  │ - Email-password backup │  │
                          │  └────────────────────────┘  │
                          │  ┌────────────────────────┐  │
                          │  │ Supabase Storage         │  │
                          │  │ - Receipt images         │  │
                          │  │ - PDF exports (statements)│  │
                          │  └────────────────────────┘  │
                          └──────────────────────────────┘
                                    │
                                    │ HTTP (internal)
                                    ▼
                    ┌──────────────────────────────┐
                    │  SYMBIOS AI SERVICE            │
                    │  (Supabase Edge Function       │
                    │   OR dedicated endpoint)       │
                    │  - Receipt OCR / Vision        │
                    │  - Categorization              │
                    │  - Confidence scoring          │
                    └──────────────────────────────┘

                    ┌──────────────────────────────┐
                    │  CRON / BACKGROUND JOBS        │
                    │  (Vercel Cron or Supabase      │
                    │   pg_cron / pg_timetable)      │
                    │  - Hostaway sync (every 6h)    │
                    │  - Revenue recognition (daily) │
                    │  - Owner statement gen (monthly)│
                    │  - Bank reconciliation (weekly) │
                    └──────────────────────────────┘

                    ┌──────────────────────────────┐
                    │  EXTERNAL ANCHORING            │
                    │  (OpenTimestamps / OP_RETURN)  │
                    │  - EvidenceLog chain head      │
                    │  - Daily anchor to Bitcoin     │
                    │  - Tamper-proof audit trail    │
                    └──────────────────────────────┘
```

---

## 3. Infrastructure Requirements

### 3.1 Hosting — Vercel

| Requirement | Current | Target | Timeline |
|-------------|---------|--------|----------|
| Plan | Hobby (free) | Pro ($20/mo) | Phase 1 |
| Domains | `booklets-one.vercel.app` | Custom: `booklets.app` / `booklets.so` | Phase 1 |
| Environment Variables | Manual dashboard | Populated via CI from 1Password/Doppler | Phase 1 |
| Preview Deployments | Per PR | Per PR with DB branching (Supabase preview) | Phase 2 |
| Concurrency | 1 concurrent build | 3 concurrent builds | Phase 1 |
| Team Members | 1 | Up to 5 (devs + reviewer) | Phase 1 |

### 3.2 Database — Supabase

| Requirement | Current | Target | Timeline |
|-------------|---------|--------|----------|
| Plan | Free | Pro ($25/mo) | Phase 1 |
| Storage | 500MB | 8GB | Phase 1 |
| Row-Level Security | NOT ENABLED | Enforced on ALL tables with `organizationId` | Phase 1 — CRITICAL |
| Backup Schedule | Point-in-time (7 days) | Enable PITR, test restore monthly | Phase 1 |
| Branching | N/A | 1 preview DB per PR | Phase 2 |
| Connection Pooling | PgBouncer (transaction mode) | Verified pooler config | Phase 1 |
| CDN for static assets | N/A | Enable for receipt images | Phase 1 |

### 3.3 Auth — Supabase Auth (Migration from Auth.js)

**Decision required:** Move from Auth.js v5 + Google OAuth to **Supabase Auth** (built-in Google provider + email-password).

| Approach | Pros | Cons |
|----------|------|------|
| **A — Stay on Auth.js** | Less migration work, existing code works | Separate from Supabase Auth RLS user resolution, two auth systems |
| **B — Migrate to Supabase Auth** | Unified RLS (auth.uid()), built-in Google OAuth, email-password fallback, Supabase UI components | Schema migration for User/Membership tables |

**Recommendation: B** — Supabase Auth integrates with RLS natively. The `auth.users` table becomes the source of truth. The `User` model maps to `auth.users.id`.

### 3.4 AI Service — SymbiOS

| Requirement | Current | Target | Timeline |
|-------------|---------|--------|----------|
| Endpoint | `localhost:8080` (hardcoded) | Configurable `SYMBIOS_URL` env var | Phase 1 |
| Deployment | Unsure | Supabase Edge Function OR Cloud Run | Phase 2 |
| Fallback | None | Manual entry form if SymbiOS unreachable | Phase 1 |
| Rate Limiting | None | 10 req/min per org, 60 req/min total | Phase 1 |
| Monitoring | None | Request logging, latency tracking, confidence distribution | Phase 2 |

### 3.5 Background Jobs

| Job | Schedule | Action | Phase |
|-----|----------|--------|-------|
| Hostaway Sync | Every 6 hours | Fetch reservations, process sync, revenue recognition | Phase 1 |
| Revenue Recognition | Every 12 hours | Find checkouts, post recognition entries | Phase 1 |
| Owner Statement Generation | 1st of each month | Generate monthly statements | Phase 2 |
| Pending Action Escalation | Every hour | Escalate stale ActionIntentQueue items > 72h | Phase 2 |
| EvidenceLog Anchor | Daily | Publish SHA256 chain head to public timestamp server | Phase 3 |
| Bank Reconciliation Import | Weekly trigger | Import statement CSV, run matching | Phase 2 |

**Implementation options:**
- **Vercel Cron Jobs** (`vercel.json` cron config) — simplest but limited to one cron per Pro plan
- **Supabase pg_cron** — runs inside Postgres, can call Edge Functions. Recommended for v1.
- **Hermes Agent (local cron)** — for dev/staging only

### 3.6 CI/CD Pipeline

```yaml
# Phase 1 Pipeline (enhance current .github/workflows/)
name: booklets-ci
on: [push, pull_request]
jobs:
  typecheck:
    - npx tsc --noEmit
  lint:
    - npx eslint src/
  test:
    - npx vitest run --coverage
    - threshold: 80% line coverage
  build:
    - npm ci
    - npm run build
  schema-check:
    - npx prisma validate
  # Phase 2
  # deploy-preview:
  #   - Deploy to Vercel preview + Supabase branch
  # e2e:
  #   - npx playwright test (against preview)
```

---

## 4. Database Infrastructure Requirements

### 4.1 Indexing Strategy

```sql
-- CRITICAL: Current missing indexes (verified against schema)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_journal_entry_org_date
  ON booklets."JournalEntry" ("organizationId", date DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_journal_entry_status
  ON booklets."JournalEntry" ("organizationId", status, date DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_journal_line_account_entry
  ON booklets."JournalLine" ("accountId", "journalEntryId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_booking_property_checkout
  ON booklets."Booking" ("propertyId", "checkOut", status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_evidence_log_tenant_chain
  ON booklets."EvidenceLog" ("tenantId", "createdAt" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_action_intent_status
  ON booklets."ActionIntentQueue" (status, "createdAt");
```

### 4.2 RLS Policies (to be applied)

```sql
-- Multi-tenant isolation template — apply to every table with organizationId
ALTER TABLE booklets."Organization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE booklets."Property" ENABLE ROW LEVEL SECURITY;
ALTER TABLE booklets."Account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE booklets."JournalEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE booklets."JournalLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE booklets."Booking" ENABLE ROW LEVEL SECURITY;
ALTER TABLE booklets."Expense" ENABLE ROW LEVEL SECURITY;
ALTER TABLE booklets."EvidenceLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE booklets."ActionIntentQueue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE booklets."FiscalPeriod" ENABLE ROW LEVEL SECURITY;

-- Each policy:
CREATE POLICY org_isolation ON booklets."JournalEntry"
  USING ("organizationId" = current_setting('app.current_org_id')::text);

-- Note: Requires a middleware that sets `app.current_org_id` after auth resolves
-- the user's membership. This MUST be set before every query.
```

### 4.3 Fiscal Period Trigger

```sql
-- Database-level enforcement — not bypassable by application code
CREATE OR REPLACE FUNCTION booklets.check_fiscal_period()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM booklets."FiscalPeriod"
    WHERE NEW.date BETWEEN "startDate" AND "endDate"
    AND ("isClosed" = true OR "locked" = true)
  ) THEN
    RAISE EXCEPTION 'Cannot post/update entry: fiscal period % is closed.',
      (SELECT name FROM booklets."FiscalPeriod"
       WHERE NEW.date BETWEEN "startDate" AND "endDate" LIMIT 1);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_journal_entry_fiscal_period_check
  BEFORE INSERT OR UPDATE ON booklets."JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION booklets.check_fiscal_period();
```

### 4.4 EvidenceLog Table Optimization

```sql
-- The EvidenceLog needs to handle high write volume.
-- Current design stores JSON payload in every row — this grows fast.
-- Recommendation: Move payload to a separate cold-storage table,
-- keep EvidenceLog lean (just hash chain + pointer).
CREATE TABLE booklets."EvidenceLogPayload" (
  "evidenceLogId" TEXT PRIMARY KEY REFERENCES "EvidenceLog"(id),
  payload JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- EvidenceLog keeps: id, eventType, tenantId, hash, previousHash, createdAt
-- (description can stay)
```

---

## 5. Security Requirements

| Req | Description | Priority |
|-----|-------------|----------|
| S-01 | **RLS on all organization-scoped tables** — see 4.2 | CRITICAL |
| S-02 | **No self-approval in 4-eyes** — APPROVE action must come from different user identity than the MAKER | CRITICAL |
| S-03 | **Idempotency keys** on all journal entry creation endpoints | HIGH |
| S-04 | **Optimistic locking** on JournalEntry (version field) | HIGH |
| S-05 | **External anchoring of EvidenceLog** — daily hash publish to OpenTimestamps or similar | MEDIUM |
| S-06 | **Rate limiting** on receipt upload endpoints (10/min per org) | MEDIUM |
| S-07 | **Audit trail for Account metadata changes** (code, name, type changes) | MEDIUM |
| S-08 | **No soft deletes on financial records** — Block POSTED entry deletes at DB level (trigger, not just app) | HIGH |

---

## 6. Observability

| Tool | Purpose | Phase |
|------|---------|-------|
| Vercel Analytics | Page speed, route tracking, error monitoring | Phase 1 |
| Supabase Logs | Query performance, slow queries, errors | Phase 1 |
| Sentry (free tier) | Error tracking, stack traces, user sessions | Phase 1 |
| Custom health endpoint | `/api/health` (exists) + `/api/health/db` (detailed) | Phase 1 |
| Dashboard for agent operations | Bus activity, sync runs, AI confidence distribution | Phase 2 |

---

## 7. Environment Configuration

```bash
# Required Environment Variables (Vercel Production + Preview)

# Database
DATABASE_URL=postgresql://postgres.[ref]:***@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&schema=booklets

# Auth
AUTH_SECRET=<openssl rand -base64 32>
AUTH_GOOGLE_ID=<google-oauth-client-id>
AUTH_GOOGLE_SECRET=<google-oauth-client-secret>
AUTH_ALLOWED_EMAILS=rajabey68@gmail.com,<other-emails>

# Hostaway PMS
HOSTAWAY_CLIENT_ID=<hostaway-client-id>
HOSTAWAY_CLIENT_SECRET=<hostaway-client-secret>
HOSTAWAY_ACCOUNT_ID=<hostaway-account-id>
# STRICT_HOSTAWAY=true  # Enable once verified

# AI Service
SYMBIOS_URL=https://symbios.booklets.internal/v1  # or deployed Edge Function URL

# External Services
EXTERNAL_FETCH_TIMEOUT_MS=30000

# Optional: Feature flags
AUTH_ALLOWLIST_MODE=strict
DISABLE_ENV_ALLOWLIST_FALLBACK=true
```

---

## 8. Phased Rollout Plan

### Phase 1 — "Make It Accounting" (2–3 weeks)
**Ship goal: Viable for single property manager — P&L, manual entry, proper ledger**

| Order | Task | Depends On | Effort |
|-------|------|------------|--------|
| 1 | Manual Journal Entry UI (form with ≥2 lines, debit/credit) | — | 2d |
| 2 | Fix Manual Booking to POST ledger entry | 1 | 1d |
| 3 | Trial Balance report page + export | 1, schema indexes | 2d |
| 4 | P&L Statement (MTD, account hierarchy for rollup) | 3 | 3d |
| 5 | Balance Sheet | 4 | 2d |
| 6 | Dashboard drill-down (click metric → see entries) | 3 | 2d |
| 7 | RLS on all tables + fiscal period DB triggers | — | 2d |
| 8 | Idempotency keys on journal posting | 7 | 1d |
| 9 | Custom domain + Vercel Pro + Supabase Pro | — | 0.5d |
| 10 | 4-eyes approval workflow UI | 1 | 3d |

### Phase 2 — "Multi-Property & Owner Ready" (2–3 weeks)
**Ship goal: Multi-property portfolio managers with owner reporting**

| Order | Task | Depends On | Effort |
|-------|------|------------|--------|
| 11 | Owner Statement generation + PDF | Phase 1 | 3d |
| 12 | Revenue share calculation engine | 11 | 2d |
| 13 | Owner portal (read-only dashboard) | Phase 1 | 3d |
| 14 | Period-end close workflow UI | Phase 1 | 2d |
| 15 | Bank reconciliation (CSV import + matching) | Phase 1 | 4d |
| 16 | P&L by Channel (Airbnb vs Booking.com vs Direct) | 4 | 2d |
| 17 | Receipt review dashboard (batch approve/reject) | Phase 1 | 3d |
| 18 | Period-over-period comparison reports | 4 | 2d |

### Phase 3 — "Scale & Integrate" (2–3 weeks)
**Ship goal: Production-ready for 50+ orgs**

| Order | Task | Depends On | Effort |
|-------|------|------------|--------|
| 19 | Multi-currency support | Phase 1 | 3d |
| 20 | Tax configuration + tax report | Phase 1 | 3d |
| 21 | Supabase DB branching for PR previews | Phase 2 | 2d |
| 22 | EvidenceLog external anchoring | Phase 1 | 2d |
| 23 | CSV/XLSX import from QuickBooks/Xero | Phase 1 | 4d |
| 24 | Supabase Auth migration (from Auth.js) | Phase 1 | 2d |
| 25 | Cashed flow statement | 4 | 1d |
