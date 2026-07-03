-- Migration: RAJ-281 Composite indexes for hot query paths
-- Reason: single-column indexes force Postgres to bitmap-AND or filter after
--         the index scan on every hot read. Each composite below matches a
--         verified query shape (database review, 2026-07-03).
-- Method: plain CREATE INDEX IF NOT EXISTS. Tables are tiny today, so the
--         short write lock is negligible; CONCURRENTLY cannot run inside
--         Prisma's migration transaction.
-- Kept:   all existing single-column indexes. JournalEntry(status),
--         JournalLine(journalEntryId), EvidenceLog(createdAt/eventType) are
--         NOT subsumed by the composites (different leading column).
--         JournalLine(accountId) IS a prefix of its composite but is kept for
--         a zero-risk rollout; drop in a later cleanup once pg_stat_user_indexes
--         confirms it is idle.
-- Rollback (run manually if needed — independent review asked for an explicit
--         recovery path; each statement is safe standalone):
--   DROP INDEX IF EXISTS "JournalEntry_organizationId_status_date_idx";
--   DROP INDEX IF EXISTS "JournalLine_accountId_journalEntryId_idx";
--   DROP INDEX IF EXISTS "Booking_propertyId_status_checkOut_idx";
--   DROP INDEX IF EXISTS "EvidenceLog_tenantId_createdAt_idx";
--   DROP INDEX IF EXISTS "ActionIntentQueue_status_createdAt_idx";

-- metrics.service.ts + trial-balance-report.ts:
--   WHERE "organizationId" = $1 AND "status" = 'POSTED' AND "date" >= $2
CREATE INDEX IF NOT EXISTS "JournalEntry_organizationId_status_date_idx"
  ON "JournalEntry"("organizationId", "status", "date");

-- ledger.service.ts getAccountBalance:
--   lines by "accountId" joined to their (POSTED) journal entries — the
--   composite serves the account lookup and the join key in one index pass.
CREATE INDEX IF NOT EXISTS "JournalLine_accountId_journalEntryId_idx"
  ON "JournalLine"("accountId", "journalEntryId");

-- revenue.service.ts recognizeRevenue + metrics:
--   WHERE "propertyId" IN (...) AND "status" = 'CONFIRMED' AND "checkOut" <= now()
CREATE INDEX IF NOT EXISTS "Booking_propertyId_status_checkOut_idx"
  ON "Booking"("propertyId", "status", "checkOut");

-- evidence-log.service.ts record() — hash-chain head lookup, executed inside
-- EVERY ledger-post transaction (hottest gap):
--   WHERE "tenantId" = $1 ORDER BY "createdAt" DESC LIMIT 1
-- DESC matches the ORDER BY so Postgres reads exactly one index tuple.
CREATE INDEX IF NOT EXISTS "EvidenceLog_tenantId_createdAt_idx"
  ON "EvidenceLog"("tenantId", "createdAt" DESC);

-- ActionIntentQueue worker (future): oldest PENDING first.
--   WHERE "status" = 'PENDING' ORDER BY "createdAt" ASC
CREATE INDEX IF NOT EXISTS "ActionIntentQueue_status_createdAt_idx"
  ON "ActionIntentQueue"("status", "createdAt");
