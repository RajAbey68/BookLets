# Briefing For Other Services: BookLets Integration

## Current Position

`/home/user/BookLets` (canonical: `https://github.com/RajAbey68/BookLets.git`,
default branch `main`) is the canonical financial system of record for the
short-term-rental property portfolio. All agent activity routes through
documented service surfaces. **No agent should write directly to the
database tables — every mutation goes through a service.**

The five service surfaces are:

- `LedgerService` — double-entry journal entries, reversals, balance reads.
- `RevenueService` — Hostaway sync, deferred-revenue lifecycle, recognition.
- `AutomationService` — receipt vision extraction → expense + journal entry.
- `EvidenceLogService` — sha256 hash-chained audit log; written by
  `LedgerService` inside the same transaction.
- `MetricsService` — derived KPIs (revenue, occupancy, ADR, RevPAR) from
  POSTED journal entries and bookings.

Plus two infrastructure modules:

- `src/lib/prisma.ts` — Prisma 7 client factory with `@prisma/adapter-pg`
  driver adapter and a financial-integrity client extension that enforces
  trial-balance, fiscal-period locks, and immutable POSTED entries.
- `src/lib/http.ts` — `fetchWithTimeout` and `fetchWithRetry` for all
  external HTTP calls. Default timeout 30s, override via
  `EXTERNAL_FETCH_TIMEOUT_MS`.

## Canonical IDs And Defaults

| Item | Value |
|---|---|
| Default Organization id | `primary_org` (seeded). Multi-tenant resolution is a tracked followup. |
| Chart of accounts (codes) | `1000` Operating Cash, `2000` Guest Pre-payments, `4000` Rental Income, `4001` Cleaning Fee Income, `5000` Commission Expense, `5001` General Operating Expense, `9999` Suspense |
| Channels (ids) | `channel_airbnb`, `channel_booking.com`, `channel_direct` |
| Fiscal period id | `fp_<year>` (auto-seeded for current year, `isClosed: false`) |
| Database URL config | `prisma.config.ts` (Prisma 7 dropped `datasource.url` from `schema.prisma`) |
| Money precision | `Decimal(19, 4)` on `JournalLine.amount`; other money columns tracked for migration in PR #5 |
| High-value journal threshold | `HIGH_VALUE_THRESHOLD = 10000` EUR (auto-DRAFT above) |
| Default currency | EUR |

## Non-Negotiable Rules

1. **Trial balance.** Every JournalEntry must satisfy
   `sum(debits) === sum(credits)` at the line level. Enforced both in
   `LedgerService.validateTrialBalance` and the `prisma` client extension.
2. **Posted entries are immutable.** POSTED entries cannot be deleted. Use
   `LedgerService.reverseEntry(entryId, reason)` (creates an inverse entry
   and marks the original VOIDED). The `prisma` extension blocks
   `journalEntry.delete` and `deleteMany` regardless.
3. **Closed fiscal periods are sealed.** No write into a FiscalPeriod with
   `isClosed: true`. Enforced in the `prisma` extension at create and update.
4. **No zero-amount lines** on POSTED entries.
5. **Money precision.** `JournalLine.amount` is `Decimal(19, 4)` — never
   round-trip through JS `number`. Other money columns (`Booking.totalAmount`,
   `Expense.amount`, `BookingCharge.amount`, `GuestPayout.amount`,
   `OwnerStatement.totalDue`) are tracked for migration in PR #5.
6. **Every ledger write is audited.** `LedgerService.postEntry` and
   `LedgerService.reverseEntry` write an `EvidenceLog` row inside the same
   transaction. Hash chain is per `tenantId` (organization). Don't bypass
   the service.
7. **No Prisma in client bundles.** `AutomationService` and other
   Prisma-touching code must never be imported into `'use client'`
   components — the `pg`/`tls` import trace breaks `npm run build`. Wrap
   them in server actions (`src/app/actions/...`).
8. **No raw `fetch()` in services.** External HTTP must go through
   `fetchWithTimeout` / `fetchWithRetry` from `src/lib/http.ts`. Bare
   `fetch` has no `AbortSignal` and stalls server actions indefinitely on
   hung upstreams.
9. **Booking sync never silently succeeds.** Per-record errors aggregate
   into `SyncReport.failures[]`. `triggerManualSync` returns a typed
   `ManualSyncResult` with `partial: boolean` so callers can surface
   partial failures. Don't swallow errors with `try { ... } catch { console.error }`.
10. **HTTP 200 from Hostaway/SymbiOS is not proof of success.** Always
    parse and validate the body shape. Pre-flight invariants (e.g.
    `AutomationService` checks property exists for the org before posting)
    are preferred over after-the-fact failure traces.

## Correct Payload Shapes

`JournalEntryInput` (from `src/lib/types.ts`):

```ts
{
  organizationId: string;
  date: Date;
  memo?: string;
  status?: JournalStatus;          // POSTED | DRAFT | VOIDED
  lines: JournalLineInput[];        // ≥ 2 lines, must balance
  // 4-Eyes governance metadata (optional, populated by automation):
  makerIdentity?: string;
  tenantId?: string;
  agentConfidence?: number;
}
```

`JournalLineInput`:

```ts
{
  accountId: string;
  amount: Decimal | number | string;   // converted via decimal.js inside service
  isDebit: boolean;
  memo?: string;
}
```

`EvidenceLogInput` (from `src/lib/evidence-log.service.ts`):

```ts
{
  eventType: string;                // e.g. "JOURNAL_POSTED" | "JOURNAL_REVERSED"
  tenantId: string;
  makerIdentity: string;
  description: string;
  payload: Record<string, unknown>;
  checkerIdentity?: string;
}
```

`SyncReport` (from `src/lib/revenue.service.ts`):

```ts
{
  reservationsFetched: number;
  bookingsProcessed: number;
  bookingsRecognized: number;
  failures: { stage: 'sync' | 'recognition'; bookingRef: string; reason: string }[];
}
```

## Read And Write Paths

**Write paths** (the only legitimate mutation surfaces — never bypass):

| Operation | Surface |
|---|---|
| Post a journal entry | `LedgerService.postEntry(input)` — atomic JournalEntry + lines + EvidenceLog |
| Reverse a journal entry | `LedgerService.reverseEntry(entryId, reason)` — atomic reversal + VOID original + EvidenceLog |
| Sync Hostaway + recognize revenue | `RevenueService.syncAndProcess(orgId)` — returns `SyncReport` |
| Recognize already-checked-out bookings | `RevenueService.recognizeRevenue(orgId, report?)` |
| Process a receipt | `AutomationService.processReceipt(orgId, propId, base64, meta?)` |
| Manual sync (server action) | `triggerManualSync()` from `src/app/actions/sync.actions.ts` |

**Read paths** (read-only is OK direct, but prefer services for derived data):

| Operation | Surface |
|---|---|
| Portfolio KPIs | `MetricsService.getPortfolioMetrics(orgId)` |
| Per-property metrics | `fetchPortfolioMetrics()` from `src/app/actions/property.actions.ts` |
| Ledger entries with lines | `fetchLedgerEntries(orgId?)` from `src/app/actions/ledger.actions.ts` |
| Account balance | `LedgerService.getAccountBalance(accountId)` |
| Verify an evidence row | `EvidenceLogService.verify(row)` re-derives sha256 |
| Direct table reads | `prisma.<model>.findMany / findUnique` (read-only) |

## Service Order To Use

For receipt automation (web or mobile):

1. Server action: `getDefaultUploadContext()` → resolves `(orgId, propId)`.
2. Server action: `processReceipt(orgId, propId, base64)` → wraps
   `AutomationService.processReceipt`. Internally handles vendor + category
   resolution, posts via `LedgerService.postEntry`, writes
   `EvidenceLog` row.

For booking sync (manual or scheduled):

1. `triggerManualSync()` server action → `RevenueService.syncAndProcess(orgId)`.
2. Returns `ManualSyncResult` with `success`, `partial`, `message`, `report`.

For arbitrary journal entries from agent code:

1. `LedgerService.postEntry({ organizationId, date, memo, status, lines, ...governance })`.
   That's it. Trial balance, fiscal-period check, evidence log all happen
   inside the call.

## Deprecated Paths

| File / Pattern | Replacement | Why |
|---|---|---|
| Tailwind classnames in components (`className="hidden lg:flex"`, `bg-blue-500/10`, `animate-pulse`, etc.) | DESIGN.md primitives once PR #2 lands (`.glass-card`, `.btn-primary`, `.is-analyzing`, `.lg-only-flex`) | No Tailwind installed; classes are dead. |
| Raw `fetch()` in services | `fetchWithTimeout` / `fetchWithRetry` from `src/lib/http.ts` | No timeouts → server-action stalls. |
| Hardcoded FK strings (`'SUSPENSE_ACC_ID'`, `'PRIMARY_BANK_ACC_ID'`, `'channel_gen_001'`) | Resolve from seed by code/name | These never matched real DB rows. |
| `try { await LedgerService.postEntry(...) } catch (err) { console.error... }` swallowing errors in sync paths | Let errors propagate; aggregate in `SyncReport.failures` | Silent partial failure was the original bug. |
| `'use client'` component importing Prisma-touching service | Wrap call in server action (`src/app/actions/<service>.actions.ts`) | Drags Prisma + pg + tls into browser bundle; breaks `npm run build`. |
| Direct `prisma.organization.findFirst()` for tenant context in actions | `getDefaultUploadContext()` (post-PR-#2) → session-derived org once auth lands | Multi-tenant unsafe. |
| `process.env.DATABASE_URL` referenced from `schema.prisma`'s `datasource.url` | Configured only in `prisma.config.ts` | Prisma 7 P1012. |
| `JournalEntry.create({ ... })` without `organizationId` | Required field, must be passed explicitly | FK constraint. |
| `account.accountType`, `journalLine.debitCredit`, `fiscalPeriod.closedAt + locked` | `account.type`, `journalLine.isDebit`, `fiscalPeriod.isClosed` | Schema renames in PR #1; old names will not resolve. |

## Current Baseline (as of `main @ bbcf03b`)

- Schema, services, and CI workflows are aligned (PR #1).
- Node 20 + actions@v4 in CI workflows; `npm install` clean (PR #1).
- EvidenceLog hash chain is live; every ledger post writes a chained row (PR #4).
- Prisma 7 client uses `@prisma/adapter-pg` driver adapter (PR #6).
- `/ledger` and `/properties` are `force-dynamic` to skip build-time DB access (PR #7).
- All external HTTP calls go through `fetchWithTimeout` / `fetchWithRetry` (PR #3).
- Hostaway OAuth refresh is single-flight; `syncAndProcess` returns typed `SyncReport`; `triggerManualSync` returns typed `ManualSyncResult` with `partial` state (PR #3).
- `AutomationService.processReceipt` does pre-flight property+org validation; SymbiOS error response includes upstream body excerpt (PR #3).
- `ReceiptUploader` is now a pure client component; receipt processing goes through the `processReceiptAction` server action so Prisma is no longer pulled into the browser bundle (PR #8).
- CI gates: P0.1–P0.6, P1.1, P1.2, P1.3, P1.5 all passing. **P1.4 (SoD) explicitly disabled, tracked.**
- `npm run build` **passes** end-to-end (PR #8).
- **Visual caveat:** the `ReceiptUploader` references design-system class names (`.glass-card`, `.is-analyzing`, `.is-success`, `.is-hil`, `.btn-primary`, `.uploader-*`) that PR #2's CSS commit defines. Until PR #2 lands, the receipt component renders unstyled but functional. PR #2 is held in draft for human visual signoff per its test plan; this is an intentional, transient state.

## Required Service Changes For Any New Agent

1. **Read this briefing first; read `AGENTS_LOG.md` second.**
2. **Claim scope in `AGENTS_LOG.md` `Active work` block before editing.** Required fields: branch name, started date, goal, files touching, files explicitly NOT touching, out-of-scope followups.
3. **Branch off latest `main`.** Never commit on `main` directly; force-pushing to `main` is forbidden.
4. **Open a draft PR as soon as you push.** That makes the claim visible on GitHub even before code lands.
5. **Mark the PR ready for review only when CI is green.**
6. **Rebase, don't merge-commit.** Preserve linear history; the merge button uses rebase mode.
7. **If you touch a service write surface** (`LedgerService`, `RevenueService`, `AutomationService`, `EvidenceLogService`), preserve the contract: same input shape, same atomicity, same evidence write. If you must change the contract, update this briefing and `AGENTS_LOG.md` in the same PR.
8. **Don't bypass the lockboard.** Cherry-picking another agent's commits via `cherry-pick -x` is acceptable for branching off in-flight work, but the upstream PR must be acknowledged in the body and the human operator notified.
9. **Treat `EvidenceLog` and `ActionIntentQueue` as proto-ODA infrastructure.** Don't repurpose them for unrelated logging — they're the audit chain for governance.

## Access Model

This repo is git-cloneable from
`https://github.com/RajAbey68/BookLets.git`. Any Linux container, GitHub
Actions runner, or Mac session can use it directly.

Required environment:

- **Node 20+** (per `next` 16.2 and `prisma` 7.6 engine requirements).
- **Postgres** reachable via `DATABASE_URL` (loaded by `prisma.config.ts`).
  Required for runtime; `prisma validate` works without one.
- **SymbiOS** receipt extraction: env `SYMBIOS_URL` (defaults to
  `http://localhost:8080`).
- **Hostaway**: env `HOSTAWAY_CLIENT_ID` + `HOSTAWAY_CLIENT_SECRET` (or
  `HOSTAWAY_API_KEY` legacy fallback) + `HOSTAWAY_ACCOUNT_ID`. Without
  those, sync runs in mock mode unless `STRICT_HOSTAWAY=true` or
  `NODE_ENV=production`.
- **Optional**: `EXTERNAL_FETCH_TIMEOUT_MS` (default 30000ms).

## Human Check Before Risky Actions

| Action | Required check |
|---|---|
| Schema migration (`prisma/schema.prisma` + new migration) | `npx prisma migrate diff` against dev DB; verify column types and `USING ::numeric` casts. **Never `migrate reset` shared environments.** |
| Disabling a P0 or P1 governance gate | Halt and request human review; gates encode invariants, not nice-to-haves. |
| New `EvidenceLog` event type | Document the payload schema in this briefing; confirm the existing chain remains verifiable via `EvidenceLogService.verify`. |
| Touching `JournalLine.isDebit` or trial-balance logic | Halt and request human review. Core integrity. |
| Production journal entry > €10,000 or near a fiscal-period boundary | Currently soft-fenced via `JournalStatus.DRAFT` for >€10k; treat as soft, not hard. |
| Anything that can leak secrets (Hostaway client_secret, SymbiOS keys) | Use the platform's secret store; never commit to git. The repo's `.gitignore` covers `.env*` but be deliberate. |

## Backlog (Not Yet First-Class)

- Real auth/session and per-request `organizationId` resolution.
- SoD enforcement (`makerIdentity !== checkerIdentity`); re-enables P1.4.
- Float → Decimal migration for remaining money columns (PR #5 in flight).
- Owner statement generation, reconciliation, and payout export.
- Multi-currency handling (currently EUR-only at the type level).
- Mobile-app shape for `ReceiptUploader` (currently web only).
- **Test infrastructure — there are no automated tests in the repo today.**
- Per-tenant serialisation of `EvidenceLog` writes (advisory lock or
  `SELECT … FOR UPDATE`) to prevent chain forking under concurrent writers.
- An automated agent-scope-guard CI check that fails any PR touching
  files outside its `AGENTS_LOG.md` claim.

## Upstream Context: Skool MCP

A separate operational charter exists for the Ghostwriter Tandem / Digital
Law Firm Skool integration at `/Users/arajiv/skool-mcp` (Mac local; not
mounted into containers). That MCP is the canonical surface for course
lesson publishing and **must not be reimplemented in BookLets**. If a
future BookLets feature needs to publish to Skool (e.g. cross-posting
educational content), wire to that MCP via the documented tools
(`skool_lessons_plan_upload`, `skool_lessons_backup`,
`skool_lessons_upload_one`, `skool_lessons_verify`); don't write to Skool
directly. See the upstream briefing for the full rules.
