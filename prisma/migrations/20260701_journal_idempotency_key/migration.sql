-- Migration: RAJ-284 [P1-02] Idempotency key on JournalEntry
-- Reason: A retried / crash-recovered / double-submitted POST must not create
--         a duplicate ledger entry. idempotencyKey = sha256(source + sourceId
--         + calendar-day) is UNIQUE. The column is nullable and Postgres
--         permits multiple NULLs in a unique index, so manual entries without
--         a source remain unconstrained.

ALTER TABLE "JournalEntry" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "JournalEntry_idempotencyKey_key"
  ON "JournalEntry"("idempotencyKey");
