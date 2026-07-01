-- Migration: RAJ-284 [P1-02] Idempotency key on JournalEntry
-- Reason: A retried / crash-recovered / double-submitted POST must not create
--         a duplicate ledger entry. idempotencyKey = sha256(source + sourceId
--         + operation + calendar-day).
-- Uniqueness is TENANT-SCOPED (organizationId, idempotencyKey), NOT global.
--         Independent review flagged a bare global unique as a cross-tenant
--         leak: an explicit caller-supplied key could collide with another
--         org's entry and a keyed lookup would return foreign financial data.
--         The composite index also permits multiple NULL keys per org
--         (Postgres treats NULLs as distinct), so keyless manual entries are
--         unconstrained.

ALTER TABLE "JournalEntry" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "JournalEntry_organizationId_idempotencyKey_key"
  ON "JournalEntry"("organizationId", "idempotencyKey");
