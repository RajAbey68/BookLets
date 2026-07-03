# BookLets — Product Requirements Document (PRD) / Functional Requirements Document (FRD)

> **Version:** 1.0
> **Status:** Draft for Claude enhancement
> **Target:** BookLets v1.0 — live STR bookkeeping SaaS

---

## 1. Product Overview

### 1.1 Vision
BookLets is an open-source, AI-native double-entry bookkeeping system purpose-built for short-term rental (STR) property managers. It replaces spreadsheets and generic accounting tools (QuickBooks, Xero) with a domain-specific system that understands bookings, channels, owner splits, and occupancy-based revenue recognition.

### 1.2 Target Users

| Persona | Role | Needs |
|---------|------|-------|
| **Property Manager** | Primary daily user | Quick booking entry, receipt upload, owner statements, P&L by property |
| **Accountant** | Periodic reviewer | Trial balance, GL drill-down, period-end close, bank reconciliation |
| **Property Owner** | Read-only investor | Owner statement, net yield per period, payout tracking |
| **AI Agent** | Automated processor | API-driven journal posting, receipt OCR pipeline, 4-eyes approval flow |

### 1.3 Core Metrics (KPIs for the product)
- Time to first P&L: < 5 minutes from data entry
- Manual journal entries required per month: 0 (all auto-posted or trigger-reviewed)
- Owner statement generation: < 3 seconds for any property/period combination
- Trial balance reconciliation time: < 1 second for 10k+ entries

---

## 2. Functional Requirements

### EPIC A: Core Double-Entry Ledger (P0 — Ship-blocking)

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| A-01 | **Journal Entry CRUD** — ability to create, view, reverse journal entries. Entry always has ≥2 lines. Debits must equal credits at post time. | P0 | Currently exists only via service layer. No UI. |
| A-02 | **Trial Balance Report** — display all accounts with their debit/credit totals and balances. Must balance to zero. | P0 | **MISSING — highest priority** |
| A-03 | **P&L (Profit & Loss) Statement** — revenue - expenses by period (MTD, QTD, YTD). Account rollup hierarchy (e.g., "Cleaning" → "Operating Expenses" → "Total Expenses"). | P0 | **MISSING — core accounting output** |
| A-04 | **Balance Sheet** — assets, liabilities, equity as of a date. | P0 | **MISSING** |
| A-05 | **Cash Flow Statement** — operating, investing, financing activities. | P1 | Indirect method acceptable for v1 |
| A-06 | **Chart of Accounts Management** — create, edit, deactivate accounts. Parent-child hierarchy (e.g., 4000 Rental Income → 4100 Airbnb Income, 4200 Direct Booking Income). | P1 | Currently seeded only — no UI |
| A-07 | **Fiscal Period Management** — create, open/close, lock periods. Hard DB-level enforcement (CHECK constraint or trigger) preventing posting to closed periods. | P1 | Schema has `isClosed`/`locked` but no DB enforcement |
| A-08 | **Idempotent Journal Posting** — idempotency key (hash of source + sourceId + date) prevents duplicate entries from crash-recovery or retry. | P1 | **MISSING — risk of ledger corruption** |
| A-09 | **Account Balances** — running balance per account, computable at any point in time. | P0 | Exists as `getAccountBalance` — needs UI |
| A-10 | **Subledger Isolation** — separate posting rules for AR, AP, fixed assets. Flat JournalLine table becomes untenable at scale. | P2 | Not urgent for v1 but plan the schema |

### EPIC B: Data Entry & Automation (P0 — Ship-blocking)

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| B-01 | **Hostaway Auto-Sync** — fetch reservations → upsert Bookings → post deferred liability → post revenue recognition on checkout. | P0 | **EXISTS**. Refine: add idempotency, fix >€10k DRAFT to be configurable per org. |
| B-02 | **Manual Booking Entry with Instant Ledger Posting** — creating a booking via form MUST also create the corresponding journal entry immediately (DR Cash / CR Guest Pre-payments). **No longer rely on "later sync".** | P0 | **CRITICAL FIX** — current design creates phantom revenue |
| B-03 | **Manual Journal Entry UI** — direct debit/credit form for accountants to post adjustments, accruals, corrections. Must support ≥3 lines (split transactions). | P0 | **MISSING — core accounting function** |
| B-04 | **AI Receipt Upload with Batch Review** — upload image → SymbiOS OCR → propose entry. Confidence < threshold → queue for batch human review. Confidence > threshold AND < 1.0 → DRAFT with human confirmation required. NEVER auto-post < 1.0. | P0 | Current >0.9=POSTED is reckless |
| B-05 | **4-Eyes Approval Workflow** — ActionIntentQueue lifecycle with:
  - Maker creates PENDING intent
  - Separate reviewer identity (not same user) must APPROVE or REJECT
  - TTL expiry → auto-escalate to OWNER
  - Full audit trail of who approved what and when
  - NO self-approval allowed for OWNER role | P0 | Exists in schema only — not enforced |
| B-06 | **Receipt Review Dashboard** — queue of DRAFT entries from AI with batch-approve/reject/edit. Side-by-side receipt image + proposed entry. | P1 | Currently entries go DRAFT with no review UI |
| B-07 | **Multi-Currency Support** — currency column on Account, JournalLine, Booking, Expense. FX rate at transaction date. Reporting in base currency. | P2 | STR managers with international bookings |
| B-08 | **Payment Reconciliation** — match Hostaway payouts to bookings. Handle commission deductions, service fees, damage deposits. Journal entry for difference. | P1 | GuestPayout model exists but no reconciliation |

### EPIC C: Owner & Guest Financials (P1 — Important)

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| C-01 | **Owner Statement Generation** — formal statement per owner per period: revenue by property, expenses, net due, payout history. | P1 | Model exists (`OwnerStatement`), no service |
| C-02 | **Revenue Share Calculation** — split booking revenue across multiple owners per PropertyOwnership.revenueShare (Decimal 5,4). | P1 | Schema exists, no service |
| C-03 | **Guest Payout Tracking** — track payouts from Hostaway, match to bookings, display in UI. | P1 | Model exists, no UI |
| C-04 | **Owner Portal** — read-only access for property owners to view their statements and payouts. | P2 | Separate VIEWER role exists but no dedicated view |

### EPIC D: Reporting & Analytics (P0 — Ship-blocking)

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| D-01 | **P&L by Property** — income and expenses per property, with drill-down to individual journal entries. | P0 | **MISSING** |
| D-02 | **P&L by Channel** — Airbnb vs Booking.com vs Direct income with expense allocation. | P1 | **MISSING** |
| D-03 | **Drill-down from Dashboard** — clicking any metric (revenue, occupancy, ADR) reveals the underlying journal entries. | P0 | **MISSING** — dashboard is currently a static image |
| D-04 | **Period-over-Period Comparison** — month-over-month, year-over-year for revenue, expenses, net income. | P1 | **MISSING** |
| D-05 | **Budget vs Actuals** — set monthly budgets per account or property, track variance. | P2 | Nice-to-have |
| D-06 | **CSV/XLSX Export for All Reports** — P&L, balance sheet, trial balance, GL. | P0 | Only GL export exists |
| D-07 | **Owner Statement Export** — PDF generation for owner distribution. | P1 | Per C-01 |

### EPIC E: Tax Management (P1 — Market Requirement)

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| E-01 | **Tax Configuration** — per-org sales tax rate (VAT, occupancy tax, tourist tax). Configurable by jurisdiction. | P1 | **MISSING** |
| E-02 | **Tax-Aware Journal Lines** — tax amount tracked per line as separate account (e.g., Output VAT, Input VAT). | P1 | No tax fields exist in schema |
| E-03 | **Tax Report** — total tax collected vs tax paid by period, ready for filing. | P2 | |

### EPIC F: Bank & Period-End (P1 — Critical for Trust)

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| F-01 | **Bank Reconciliation** — import bank statement CSV, match to journal entries, flag unmatched items, carry forward uncleared. | P1 | **MISSING — most-requested accounting feature** |
| F-02 | **Period-End Close Workflow** — checklist: trial balance → review adjusting entries → post accruals → lock period → generate financial statements. Re-open with audit trail only. | P1 | Currently a boolean toggle |
| F-03 | **Inter-Property Allocations** — shared expenses (marketing, cleaning, management fees) allocated across properties by formula. | P2 | |

### EPIC G: AI & Automation Infrastructure (P1)

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| G-01 | **SymbiOS Integration Service** — configurable endpoint URL, retry logic, fallback to manual entry. | P1 | Hardcoded localhost — needs env config |
| G-02 | **Confidence Threshold Configuration** — per-org threshold for auto-POST vs DRAFT. Default 0.95 (not 0.9). | P1 | Currently hardcoded at 0.9 |
| G-03 | **Categorization Training** — learn from human corrections to improve category suggestion accuracy. | P2 | |

---

## 3. Data Model Changes Required

### 3.1 Schema Changes (High Priority)

```prisma
// New: Account hierarchy for rollup reporting
model Account {
  parentId   String?   // Self-referencing hierarchy
  parent     Account?  @relation("AccountHierarchy", fields: [parentId], references: [id])
  children   Account[] @relation("AccountHierarchy")
  // + existing fields
}

// New: Account type expansion
// Add: CONTRA_ASSET, CONTRA_LIABILITY, CONTRA_REVENUE, CONTRA_EXPENSE

// Add: fiscalPeriodId to JournalEntry
model JournalEntry {
  fiscalPeriodId String?
  fiscalPeriod   FiscalPeriod? @relation(fields: [fiscalPeriodId], references: [id])
  // + existing fields
}

// NEW: Tax management
model TaxRate {
  id             String   @id @default(cuid())
  organizationId String
  name           String   // "Irish VAT 23%", "Tourist Tax 3.5%"
  rate           Decimal  @db.Decimal(5, 4)
  jurisdiction   String   // Country, region, or city
  accountId      String   // GL account for tax liability
  isActive       Boolean  @default(true)
  createdAt      DateTime @default(now())
  organization   Organization @relation(fields: [organizationId], references: [id])
  account        Account  @relation(fields: [accountId], references: [id])
}

// NEW: Multi-currency
// Add currency field to: Account, JournalLine, Booking, Expense
// Account already has `currency` — extend to others

// FIX: Add idempotency key
model JournalEntry {
  idempotencyKey String?  @unique  // hash(source + sourceId + date)
  // + existing fields
}

// FIX: Add optimism lock version
model JournalEntry {
  version Int @default(1)  // For optimistic concurrency
  // + existing fields
}
```

### 3.2 Security Schema Changes

```prisma
// NEW: DB-level enforcement for fiscal period
// Add PostgreSQL trigger (not just application code):
// CREATE OR REPLACE FUNCTION booklets.check_fiscal_period()
// RETURNS TRIGGER AS $$
// BEGIN
//   IF EXISTS (
//     SELECT 1 FROM "FiscalPeriod"
//     WHERE NEW.date BETWEEN "startDate" AND "endDate"
//     AND ("isClosed" = true OR "locked" = true)
//   ) THEN
//     RAISE EXCEPTION 'Cannot post to closed fiscal period';
//   END IF;
//   RETURN NEW;
// END;
// $$ LANGUAGE plpgsql;
//
// CREATE TRIGGER trg_journal_entry_fiscal_period
// BEFORE INSERT OR UPDATE ON "JournalEntry"
// FOR EACH ROW EXECUTE FUNCTION booklets.check_fiscal_period();

// FIX: PostgreSQL RLS policies on every table with organizationId
// ALTER TABLE booklets."JournalEntry" ENABLE ROW LEVEL SECURITY;
// CREATE POLICY org_isolation ON booklets."JournalEntry"
//   USING ("organizationId" = current_setting('app.current_org_id')::text);
```

---

## 4. Non-Functional Requirements

| ID | Requirement | Target | Notes |
|----|-------------|--------|-------|
| N-01 | **Ledger Immutability** | Zero deletions. Reversals only. | Prisma extension blocks POSTED deletes. Need DB trigger to enforce. |
| N-02 | **Multi-Tenant Data Isolation** | RLS on every table. No org can see another's data. | **MISSING** — application-only isolation is insufficient |
| N-03 | **Audit Trail Completeness** | All mutations logged in EvidenceLog. SHA256 chain anchored externally (published to public blockchain or timestamped by trusted authority). | Current SHA256 chain lives in same DB — security theater |
| N-04 | **Response Time** | Dashboard: < 500ms. GL with 10k entries: < 2s. Report generation: < 3s. | Current queries work at small scale — need indexing strategy |
| N-05 | **Availability** | 99.9% uptime. Maintenance window < 1hr/month. | Vercel + Supabase standard SLA |
| N-06 | **Data Retention** | Financial data: 7 years minimum (legal requirement for most jurisdictions). | |

---

## 5. Future Considerations (v2)

- **Fixed Asset Management** — depreciation schedule for property furnishings
- **Payroll / Contractor Payments** — 1099/NRC import and payment tracking
- **Escrow / Trust Accounting** — for damage deposits and guest prepayments
- **Multi-Entity Consolidation** — each property as a separate LLC with consolidated reporting
- **API for external integrations** — REST/GraphQL beyond current Hostaway
- **Import from QuickBooks/Xero** — CSV/XLSX import with chart-of-accounts mapping
