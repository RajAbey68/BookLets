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

-- Pre-flight guard (independent review, DeepSeek 424949f5): abort loudly if
-- any row holds a free-text type outside the enum — the cast below would
-- otherwise fail mid-migration. Live data was verified (2026-07-03) to hold
-- only the six values, but the guard makes that assumption explicit.
DO $$
DECLARE bad_count integer;
BEGIN
  SELECT count(*) INTO bad_count FROM "Account"
  WHERE "type" NOT IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE', 'SUSPENSE');
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'account_type_enum migration aborted: % Account rows have a type outside the enum', bad_count;
  END IF;
END $$;

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
