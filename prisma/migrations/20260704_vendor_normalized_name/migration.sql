-- Migration: RAJ-513 [fix round, finding 2] Deterministic vendor identity
-- Reason: the org-scoped vendor lookup used an unordered `contains` match —
--         with several partial matches the same receipt could attach to a
--         different vendor run-to-run. AutomationService now matches exactly
--         on a canonical normalizedName (trim/lowercase/collapse whitespace)
--         before falling back to the oldest contains-match, and the per-org
--         unique index below makes concurrent duplicate vendors impossible.
-- Safety: prod (euqdfxekrxnoibeahogq) verified 2026-07-04 — "Vendor" has
--         0 rows, so adding a unique index cannot conflict. Add-only —
--         strictly additive statements. NULL normalizedName values (none)
--         are distinct under Postgres unique semantics, so legacy rows
--         could never block each other.

ALTER TABLE "Vendor" ADD COLUMN IF NOT EXISTS "normalizedName" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Vendor_organizationId_normalizedName_key"
  ON "Vendor"("organizationId", "normalizedName");
