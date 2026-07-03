-- Migration: RAJ-455 Structured provenance fields on JournalEntry
-- Reason: handleBookingCancellation located the entry to reverse via
--         memo: { contains: hostawayId } — a fragile substring match that
--         silently no-oped when the memo drifted, leaving a cancelled
--         booking's deferred liability on the books. source/sourceId give
--         entries a structural provenance link (source='booking',
--         sourceId=<booking.id>) matching the RAJ-284 idempotency contract,
--         so reversal lookups are exact and tenant-scoped.

ALTER TABLE "JournalEntry" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "JournalEntry" ADD COLUMN IF NOT EXISTS "sourceId" TEXT;

CREATE INDEX IF NOT EXISTS "JournalEntry_organizationId_source_sourceId_idx"
  ON "JournalEntry"("organizationId", "source", "sourceId");
