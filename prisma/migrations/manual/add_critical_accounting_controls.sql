-- BookLets Critical Accounting Controls Migration
-- Blocks P2 ship until applied
-- Applied via: psql $DATABASE_URL -f prisma/migrations/manual/add_critical_accounting_controls.sql

-- 1. ADD sourceHash column to JournalEntry (idempotency key)
ALTER TABLE "JournalEntry" ADD COLUMN IF NOT EXISTS "sourceHash" VARCHAR(256);
CREATE UNIQUE INDEX IF NOT EXISTS "JournalEntry_sourceHash_key" ON "JournalEntry"("sourceHash") WHERE "sourceHash" IS NOT NULL;

-- 2. PERIOD CLOSURE ENFORCEMENT TRIGGER
-- Prevents edits to JournalEntry if the entry's date falls within a closed FiscalPeriod
CREATE OR REPLACE FUNCTION prevent_closed_period_edits()
RETURNS TRIGGER AS $$
DECLARE
  v_period RECORD;
BEGIN
  -- Check if the entry's date falls within a closed fiscal period
  SELECT fp.* INTO v_period
  FROM "FiscalPeriod" fp
  WHERE fp."organizationId" = NEW."organizationId"
    AND NEW.date >= fp."startDate"
    AND NEW.date <= fp."endDate"
    AND fp."isClosed" = true
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Fiscal Integrity Violation: Cannot modify journal entry dated % because it falls within the closed fiscal period "%". Only reversing entries are permitted.',
      TO_CHAR(NEW.date, 'YYYY-MM-DD'), v_period.name;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if it exists (to allow re-running this migration)
DROP TRIGGER IF EXISTS prevent_journal_entry_edit_closed_period ON "JournalEntry";

-- Create trigger on UPDATE
CREATE TRIGGER prevent_journal_entry_edit_closed_period
BEFORE UPDATE ON "JournalEntry"
FOR EACH ROW
EXECUTE FUNCTION prevent_closed_period_edits();

-- 3. IMMUTABILITY FOR POSTED ENTRIES
-- Prevent any UPDATE to a POSTED entry (only reversals allowed)
CREATE OR REPLACE FUNCTION prevent_edit_posted_entry()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'POSTED' AND (
    OLD."memo" IS DISTINCT FROM NEW."memo" OR
    OLD.date IS DISTINCT FROM NEW.date OR
    OLD.status IS DISTINCT FROM NEW.status
  ) THEN
    RAISE EXCEPTION 'Audit Integrity Violation: Cannot edit a POSTED journal entry (id: %). Create a reversing entry instead.', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prevent_edit_posted_journal_entry ON "JournalEntry";

CREATE TRIGGER prevent_edit_posted_journal_entry
BEFORE UPDATE ON "JournalEntry"
FOR EACH ROW
EXECUTE FUNCTION prevent_edit_posted_entry();

-- 4. DOUBLE-ENTRY VALIDATION CHECK CONSTRAINT
-- Ensure that journal entries have at least 2 lines (minimum for double-entry)
-- Note: The application layer must verify debits = credits; this trigger only checks line count.
-- A future trigger can be added to validate the balance if needed.

-- Create a helper function to validate double-entry
CREATE OR REPLACE FUNCTION validate_double_entry()
RETURNS TRIGGER AS $$
DECLARE
  v_line_count INTEGER;
  v_debit_total NUMERIC(19, 4);
  v_credit_total NUMERIC(19, 4);
BEGIN
  IF NEW.status = 'POSTED' THEN
    -- Count lines for this entry
    SELECT COUNT(*)::INTEGER INTO v_line_count
    FROM "JournalLine"
    WHERE "journalEntryId" = NEW.id;

    -- Verify at least 2 lines
    IF v_line_count < 2 THEN
      RAISE EXCEPTION 'Trial Balance Violation: Journal entry must have at least 2 lines. Current count: %', v_line_count;
    END IF;

    -- Verify debits = credits
    SELECT
      COALESCE(SUM(CASE WHEN "isDebit" = true THEN "amount" ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN "isDebit" = false THEN "amount" ELSE 0 END), 0)
    INTO v_debit_total, v_credit_total
    FROM "JournalLine"
    WHERE "journalEntryId" = NEW.id;

    IF v_debit_total != v_credit_total THEN
      RAISE EXCEPTION 'Trial Balance Violation: Entry is unbalanced. Debits: %, Credits: %. Debits must equal Credits.',
        v_debit_total, v_credit_total;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_journal_entry_balance ON "JournalEntry";

CREATE TRIGGER validate_journal_entry_balance
BEFORE INSERT OR UPDATE ON "JournalEntry"
FOR EACH ROW
EXECUTE FUNCTION validate_double_entry();

-- 5. AUDIT LOG TABLE (for future reconciliation and compliance)
-- Tracks when periods are closed and by whom
CREATE TABLE IF NOT EXISTS "PeriodClosureAudit" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" TEXT NOT NULL REFERENCES "Organization"(id) ON DELETE CASCADE,
  "periodId" TEXT NOT NULL REFERENCES "FiscalPeriod"(id) ON DELETE CASCADE,
  "closedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "closedBy" TEXT,
  "entryCount" INTEGER,
  "netAmount" VARCHAR(256),
  notes TEXT,
  CONSTRAINT unique_period_closure UNIQUE("periodId")
);

CREATE INDEX IF NOT EXISTS "PeriodClosureAudit_organizationId_idx" ON "PeriodClosureAudit"("organizationId");
CREATE INDEX IF NOT EXISTS "PeriodClosureAudit_closedAt_idx" ON "PeriodClosureAudit"("closedAt");

-- End of migration
-- Verify: SELECT * FROM pg_triggers WHERE tgname LIKE 'prevent_%' OR tgname LIKE 'validate_%';
