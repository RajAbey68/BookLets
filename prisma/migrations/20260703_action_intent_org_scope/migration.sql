-- Migration: RAJ-292/294 [P1-10/P1-12] Tenant scope for the 4-eyes queue
-- Reason: ActionIntentQueue predates multi-tenancy and had no organizationId,
--         so any listing was inherently cross-tenant (flagged by independent
--         review as the top risk). The table has zero producers today, so the
--         column is added nullable with no backfill; the /approvals surface
--         filters reads AND guards decisions on organizationId, making an
--         org-less intent invisible and undecidable rather than leakable.

ALTER TABLE "ActionIntentQueue" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

CREATE INDEX IF NOT EXISTS "ActionIntentQueue_organizationId_idx"
  ON "ActionIntentQueue"("organizationId");
