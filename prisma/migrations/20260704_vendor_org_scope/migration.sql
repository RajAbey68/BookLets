-- Migration: RAJ-513 [Sprint 0] Tenant scope for vendor resolution
-- Reason: AutomationService matched vendors by bare name `contains` with no
--         organization filter, so two tenants sharing a vendor name silently
--         shared one Vendor row (cross-tenant bleed). Add-only retrofit,
--         mirroring 20260703_action_intent_org_scope: the column is nullable
--         with no backfill; the service scopes lookups AND stamps the org on
--         create, so legacy org-less rows simply stop matching.

ALTER TABLE "Vendor" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

CREATE INDEX IF NOT EXISTS "Vendor_organizationId_idx"
  ON "Vendor"("organizationId");
