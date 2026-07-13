# EXTERNAL ADVERSARIAL REVIEW PACKET №2 — HR-5 prod DDL + S1b bridge contract

**To the reviewing model (Grok 4.5 / GLM 5.2):** You are an independent,
adversarial reviewer. You have NO access to the repository or database — this
packet is self-contained. Your job is to find reasons the plan below is WRONG,
UNSAFE, or DISHONEST before it executes against a production database. Do not
be polite. If you cannot break it, say so explicitly and sign the verdict.

## A. Context (verified facts, two independent checkers)
- Prod: Supabase Postgres, single instance. App tables in schema `public`
  (20 Prisma-managed tables). Staging schema `raj_fin_track` holds 468 OCR'd
  receipt rows loaded by a devserver pipeline; the app has ZERO code references
  to it. Ledger table `public."JournalEntry"` has 10 seed rows.
- Prod schema was managed by `prisma db push` (no `_prisma_migrations` table)
  and has drifted: missing `AccountType` enum (root cause of the live 500),
  missing `JournalEntry.idempotencyKey/source/sourceId/version`,
  `Account.parentId/isHeader`, `ActionIntentQueue.organizationId`, several
  composite indexes. Nine migration folders exist in the repo that prod never ran.
- A foreign trigger `trg_prevent_auction_delete` (not ours) exists on a public
  table. `raj_fin_track` must not be touched by the fix.
- Receipt quality snapshot: of 468 staged rows — 179 postable now
  (LKR, dated, amount>0, OCR success), 138 OCR-failed, 111 missing doc_date,
  29 missing/zero amount, 11 non-LKR (GBP/USD/other). Books are LKR.
- Plan generation method: live prod DDL was introspected READ-ONLY, replayed
  into a local shadow Postgres 16, `prisma migrate diff` produced the corrective
  script, the one destructive statement was hand-rewritten (see B), the corrected
  script was applied to the shadow, and a re-diff returned "No difference
  detected" (i.e., the script provably reaches the target schema).

## B. Artifact 1 — the DDL to be executed on prod (verbatim)
Execution rules: pg_dump backup first; single transaction; direct :5432
connection; on any error ROLLBACK and stop; afterwards `prisma migrate resolve
--applied` ×9 to baseline history; then verify health endpoint = 200.

```sql
BEGIN;

CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE', 'SUSPENSE');

-- Prisma's generated diff wanted: DROP COLUMN "type" / ADD COLUMN "type" NOT NULL
-- (data loss + fails on non-empty table). Rewritten as an in-place cast.
-- Live values verified: {ASSET, EXPENSE, LIABILITY, REVENUE, SUSPENSE}, 6 rows.
ALTER TABLE "Account"
  ALTER COLUMN "type" TYPE "AccountType" USING ("type"::"AccountType");
ALTER TABLE "Account"
  ADD COLUMN "isHeader" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "parentId" TEXT;

ALTER TABLE "ActionIntentQueue" ADD COLUMN "organizationId" TEXT;

ALTER TABLE "JournalEntry"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "source" TEXT,
  ADD COLUMN "sourceId" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE INDEX "Account_parentId_idx" ON "Account"("parentId");
CREATE UNIQUE INDEX "Account_id_organizationId_key" ON "Account"("id", "organizationId");
CREATE INDEX "ActionIntentQueue_organizationId_idx" ON "ActionIntentQueue"("organizationId");
CREATE INDEX "ActionIntentQueue_status_createdAt_idx" ON "ActionIntentQueue"("status", "createdAt");
CREATE INDEX "Booking_propertyId_status_checkOut_idx" ON "Booking"("propertyId", "status", "checkOut");
CREATE INDEX "EvidenceLog_tenantId_createdAt_idx" ON "EvidenceLog"("tenantId", "createdAt" DESC);
CREATE INDEX "JournalEntry_organizationId_source_sourceId_idx" ON "JournalEntry"("organizationId", "source", "sourceId");
CREATE INDEX "JournalEntry_organizationId_status_date_idx" ON "JournalEntry"("organizationId", "status", "date");
CREATE UNIQUE INDEX "JournalEntry_organizationId_idempotencyKey_key" ON "JournalEntry"("organizationId", "idempotencyKey");
CREATE INDEX "JournalLine_accountId_journalEntryId_idx" ON "JournalLine"("accountId", "journalEntryId");

ALTER TABLE "Account" ADD CONSTRAINT "Account_parentId_organizationId_fkey"
  FOREIGN KEY ("parentId", "organizationId") REFERENCES "Account"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
```

## C. Artifact 2 — S1b bridge contract (summary; full text in repo)
- In-app importer service + admin API route. Reads
  `raj_fin_track.ocr_receipts` cross-schema via raw SQL (table deliberately NOT
  added to the ORM datamodel; staging is read-only to the app). Same Postgres
  instance, so no upload transport / body limits.
- Eligible rows (`ocr_status='success' AND total_amount>0 AND doc_date IS NOT
  NULL AND currency='LKR'`) → `LedgerService.postEntry`: DRAFT-only (a typed
  gate makes POSTED unreachable for automated entries), debit mapped expense
  account (Suspense 9999 fallback), credit bank (1000, Suspense fallback),
  `idempotencyKey='ocr-receipt:'+source_file` unique per org (replay-safe),
  `source='OCR_RECEIPT'`, `sourceId=id`.
- Everything else PARKS with a reason code returned in the response summary:
  OCR_FAILED(138), NO_DOC_DATE(111 — no date fabrication from processed_at),
  BAD_AMOUNT(29), FX_UNSUPPORTED(11 — LKR books; FX-at-txn-date is the agreed
  end-state but is deferred until a real rate source (Wise import) exists).
- Batched (50/invocation), idempotent, re-invoked until `remaining: 0`.
- Acceptance: ledger count == eligible count, all DRAFT; re-run inserts 0;
  3 staging↔ledger spot checks; parked+posted == staging total; independent
  Layer-2 re-count before PASS.
- Hard prerequisite ordering: HR-5 DDL first (bridge writes columns that don't
  exist yet), then a read GRANT on the staging table, then build.

## D. Sequencing claim under review
HR-5 (DDL above) → verify health 200 → rebase & merge deploy-fix PR (#74,
currently conflicted; fixes an auth fail-open) → point canonical Vercel domain
at `main` → curl proof → grant staging read (HR-6) → build S1b → review UI /
reconciliation finally have real input. Claim: merging app PRs BEFORE the DDL
ships dead code against a drifted DB; the 500 is a DB defect, not an app defect.

## E. Attack this. Specifically:
1. The in-place enum cast: any way it corrupts/locks? (Table has 6 rows; cast
   fails loudly on unexpected values. Is `USING (col::enum)` safe under a
   concurrent writer? Should the app be paused during the transaction?)
2. `CREATE UNIQUE INDEX "Account_id_organizationId_key"` and the composite FK —
   failure modes on existing data? (id is PK, so uniqueness is trivially true —
   confirm or refute.)
3. `JournalEntry_organizationId_idempotencyKey_key` unique on a column that is
   NULL for all 10 existing rows — Postgres NULL-uniqueness semantics: problem
   or not?
4. Baselining with `migrate resolve --applied` ×9 when one of those migrations
   contains raw-SQL triggers applied separately — any way history and reality
   diverge afterwards?
5. The bridge's parking rules: is refusing to fabricate doc_dates correct
   accounting practice, or should there be a documented fallback (e.g., file
   mtime) with disclosure? Is parking 62% of rows acceptable to call S1b "done"?
6. Idempotency: `source_file` as the key — what if the OCR pipeline re-processes
   the same file with a DIFFERENT amount (correction run)? Does the bridge
   silently keep the stale entry? Is that acceptable for DRAFTs?
7. The transaction wraps CREATE INDEX (not CONCURRENTLY) — table sizes are tiny
   (≤500 rows), so lock time is negligible: confirm this reasoning or refute.
8. Anything in the sequencing (D) you would reorder, and why?
9. General: what is the most damaging thing this plan could do to a production
   accounting database, and what single change most reduces that risk?

## F. Required verdict format (paste back verbatim)
```
REVIEWER: <model name/version>
VERDICT: PASS | PASS-WITH-CONDITIONS | FAIL
BLOCKING FINDINGS: <numbered, each with concrete failure scenario>
NON-BLOCKING FINDINGS: <numbered>
ANSWERS E1–E9: <one line each>
SIGNATURE LINE: "I attempted to break this plan and <could / could not> beyond the findings above."
```
