-- Migration: RAJ-283 [P1-01] Account self-referencing hierarchy
-- Reason: Enable rollup reporting — parent accounts (e.g. 4000 Rental Income)
--         aggregate the balances of their children (4100 Airbnb, 4200 Direct).
--         Root accounts have no parent, so the FK is nullable.
-- Referential action: ON DELETE RESTRICT (NOT SET NULL). Independent review
--         flagged SET NULL as silent financial corruption — deleting a parent
--         would orphan its children into roots and drop them from the parent's
--         rolled-up balance with no audit trail. RESTRICT blocks deleting an
--         account that still has children; accounts are deactivated (closedAt/
--         locked), not deleted.

ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "parentId" TEXT;

CREATE INDEX IF NOT EXISTS "Account_parentId_idx" ON "Account"("parentId");

ALTER TABLE "Account"
  ADD CONSTRAINT "Account_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "Account"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Block the trivial self-referencing cycle (an account being its own parent)
-- at the database level. Deeper cycles are rejected by AccountService.rollup.
ALTER TABLE "Account" ADD CONSTRAINT "Account_no_self_parent" CHECK ("id" <> "parentId");
