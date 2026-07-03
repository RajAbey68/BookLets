-- Migration: RAJ-403 + RAJ-404 — Account type enum, isHeader flag, org-scoped parent
--
-- RAJ-403: Account.type was free text. P&L rollup (RAJ-289) needs a closed
--          type set to separate revenue from expenses and apply normal-balance
--          sign conventions. SUSPENSE is included because live data already
--          uses it for the 9999 clearing account.
-- RAJ-404: parentId could reference an account in ANOTHER organization — a
--          tenant-isolation breach. The composite FK below makes a cross-org
--          parent unrepresentable: the referenced (id, organizationId) pair
--          must match the child's own organizationId.

-- RAJ-403: closed enum for account types; cast existing rows in place.
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE', 'SUSPENSE');
ALTER TABLE "Account"
  ALTER COLUMN "type" TYPE "AccountType" USING "type"::"AccountType";

-- RAJ-403: header accounts group children for reporting; no direct postings.
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "isHeader" BOOLEAN NOT NULL DEFAULT false;

-- RAJ-404: composite FK target — (id, organizationId) must be unique.
CREATE UNIQUE INDEX IF NOT EXISTS "Account_id_organizationId_key" ON "Account"("id", "organizationId");

-- RAJ-404: replace the single-column parent FK with the org-scoped composite.
ALTER TABLE "Account" DROP CONSTRAINT IF EXISTS "Account_parentId_fkey";
ALTER TABLE "Account"
  ADD CONSTRAINT "Account_parentId_organizationId_fkey"
  FOREIGN KEY ("parentId", "organizationId")
  REFERENCES "Account"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
