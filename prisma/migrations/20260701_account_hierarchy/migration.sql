-- Migration: RAJ-283 [P1-01] Account self-referencing hierarchy
-- Reason: Enable rollup reporting — parent accounts (e.g. 4000 Rental Income)
--         aggregate the balances of their children (4100 Airbnb, 4200 Direct).
--         Root accounts have no parent, so the FK is nullable.
-- Referential action matches Prisma's default for an optional self-relation:
--   ON DELETE SET NULL, ON UPDATE CASCADE.

ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "parentId" TEXT;

CREATE INDEX IF NOT EXISTS "Account_parentId_idx" ON "Account"("parentId");

ALTER TABLE "Account"
  ADD CONSTRAINT "Account_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "Account"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
