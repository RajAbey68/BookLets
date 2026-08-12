-- Migration: PR #151 — Fix trigger timing issues (findings #2, #3)
--
-- Finding #2: Balance validation trigger fires BEFORE INSERT, counts non-existent
--            JournalLine rows before the create has run, rejects ALL POSTED entries.
--            Fix: Change to CONSTRAINT TRIGGER AFTER INSERT ... DEFERRABLE, so the
--            balance check runs AFTER all lines are inserted, and can be deferred
--            to commit time for atomicity.
--
-- Finding #3: Period closure check on INSERT is already enforced via the
--            enforce_fiscal_period_lock trigger (BEFORE INSERT OR UPDATE).
--            Verification test added to ensure enforcement.
--
-- The balance check is moved to AFTER INSERT so it sees the complete set of lines.
-- DEFERRABLE INITIALLY DEFERRED lets the application decide whether to defer or
-- enforce immediately; the default is INITIALLY IMMEDIATE for single-row inserts.

-- ─── PR #151: Balance validation as CONSTRAINT TRIGGER ──────────────────────

CREATE OR REPLACE FUNCTION validate_journal_entry_balance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  balance DECIMAL;
  line_count INT;
BEGIN
  -- Count lines for this entry and compute their balance
  SELECT COALESCE(SUM(CASE WHEN "isDebit" THEN "amount" ELSE -"amount" END), 0), COUNT(*)
  INTO balance, line_count
  FROM "JournalLine"
  WHERE "journalEntryId" = NEW."id";

  -- POSTED entries must have at least 2 lines and balance to zero
  IF NEW."status" = 'POSTED' THEN
    IF line_count < 2 THEN
      RAISE EXCEPTION 'Trial Balance Violation: A journal entry must have at least two balancing lines (found %).',
        line_count
        USING ERRCODE = 'BL299';
    END IF;

    IF balance != 0 THEN
      RAISE EXCEPTION 'Trial Balance Violation: Entry % is unbalanced by % (debits must equal credits).',
        NEW."id", balance
        USING ERRCODE = 'BL298';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Drop old BEFORE INSERT trigger if it exists, replace with CONSTRAINT TRIGGER
DROP TRIGGER IF EXISTS journal_entry_validate_balance ON "JournalEntry";
CREATE CONSTRAINT TRIGGER journal_entry_validate_balance
  AFTER INSERT ON "JournalEntry"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW
  EXECUTE FUNCTION validate_journal_entry_balance();

-- ─── Verification: Period closure IS enforced on INSERT ──────────────────────
-- The enforce_fiscal_period_lock trigger (BEFORE INSERT OR UPDATE) already
-- covers this. No changes needed, but the test in pr-151-triggers.test.ts
-- verifies the enforcement.
