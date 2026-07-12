-- ============================================================================
-- HR-5 APPENDIX: EXACT CORRECTIVE DDL — prod baseline (public schema)
-- ============================================================================
-- Companion to docs/runs/MIGRATION-BASELINE-PLAN.md. Read that first.
--
-- HOW THIS WAS GENERATED (fully non-mutating against prod):
--   1. Live prod DDL introspected read-only via pg_catalog on 2026-07-12
--      (Supabase project euqdfxekrxnoibeahogq, columns/constraints/indexes).
--   2. That state was replayed into a local shadow Postgres 16.
--   3. `prisma migrate diff --from-config-datasource --to-schema
--      prisma/schema.prisma --script` was run against the shadow.
--   4. The ONE destructive statement Prisma emitted
--      (DROP COLUMN "type" / ADD COLUMN "type" NOT NULL on "Account" —
--      would destroy data and fail on a non-empty table) was rewritten as a
--      lossless in-place cast. Live values were verified to be a subset of
--      the enum: ASSET, EXPENSE, LIABILITY, REVENUE, SUSPENSE (6 rows).
--   5. This corrected script was applied to the shadow and re-diffed:
--      `prisma migrate diff` reports EMPTY — shadow now matches
--      prisma/schema.prisma exactly.
--
-- EXECUTION RULES (Hermes):
--   * Backup FIRST (foreign trigger trg_prevent_auction_delete present;
--     raj_fin_track schema must not be touched — this script only references
--     public."..." Prisma tables).
--   * Run inside a single transaction on the DIRECT (5432) connection.
--   * After success, run the `migrate resolve --applied` baseline steps in
--     MIGRATION-BASELINE-PLAN.md, then the raw-SQL triggers migration.
--   * If any statement errors: ROLLBACK, report on the bus, stop.
-- ============================================================================

BEGIN;

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE', 'SUSPENSE');

-- AlterTable: Account
-- SAFE CAST (replaces Prisma's destructive DROP/ADD): text -> enum in place.
-- Verified live values are all valid labels; USING cast fails loudly on any
-- unexpected value instead of silently losing data.
ALTER TABLE "Account"
  ALTER COLUMN "type" TYPE "AccountType" USING ("type"::"AccountType");
ALTER TABLE "Account"
  ADD COLUMN "isHeader" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "parentId" TEXT;

-- AlterTable: ActionIntentQueue (nullable — existing rows unaffected)
ALTER TABLE "ActionIntentQueue" ADD COLUMN "organizationId" TEXT;

-- AlterTable: JournalEntry (all nullable or defaulted — existing rows unaffected)
ALTER TABLE "JournalEntry"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "source" TEXT,
  ADD COLUMN "sourceId" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
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

-- AddForeignKey (self-referential account hierarchy, org-scoped)
ALTER TABLE "Account" ADD CONSTRAINT "Account_parentId_organizationId_fkey"
  FOREIGN KEY ("parentId", "organizationId") REFERENCES "Account"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
