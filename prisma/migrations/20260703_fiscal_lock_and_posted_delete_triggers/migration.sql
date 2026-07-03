-- Migration: RAJ-282 + RAJ-295 — DB-level fiscal-period lock & POSTED-entry immutability
-- Reason: Both rules are enforced today ONLY in the Prisma client extension
--         (src/lib/prisma.ts $extends hooks) — bypassable by raw SQL, the
--         Supabase SQL editor, or any direct Postgres client. Triggers make
--         the database itself the last line of defence.
--
-- RAJ-282: BEFORE INSERT OR UPDATE on "JournalEntry" — reject when the entry
--         date falls within a CLOSED FiscalPeriod of the SAME organization.
--         Mirrors LedgerService.checkFiscalPeriod: org-scoped, inclusive
--         bounds ("startDate" <= date <= "endDate"), and the "closed"
--         decision is "isClosed" = true. Per independent review (DeepSeek,
--         2026-07-03) the trigger ALSO treats "locked" = true as closed:
--         no application code sets locked (it defaults false), so this is
--         behaviour-identical today, but it closes the hole where a direct
--         DB writer flips isClosed back to false while locked stays true.
--         The trigger deliberately does NOT require a period to exist
--         (checkFiscalPeriod's "no period defined" throw) — reversals and
--         extension-path creates legitimately write dates with no defined
--         period today; tightening that is a separate policy decision.
--         On UPDATE the check runs only when "date" or "organizationId"
--         actually changes, and it checks BOTH the old and new position:
--         moving an entry INTO a closed period is rejected, and moving one
--         OUT of a closed period is rejected too (either direction silently
--         rewrites locked-period financials). Status/memo/version updates on
--         entries sitting in closed periods (e.g. VOIDED marking during a
--         reversal) remain allowed — same semantics as the client extension,
--         which only checks when data.date is supplied.
--
-- RAJ-295: BEFORE DELETE on "JournalEntry" — POSTED entries are immutable
--         audit records; they must be voided or reversed, never deleted.
--
-- Hardening (database review 2026-07-03): CHECK "amount" > 0 on "JournalLine".
--         Sign is carried by "isDebit"; every write path (LedgerService.postEntry,
--         reverseEntry, manual-journal-entry validation) uses strictly positive
--         amounts, and postEntry rejects zero-amount lines for POSTED entries.
--         PRE-DEPLOY CHECK (constraint validates existing rows on apply):
--           SELECT count(*) FROM "JournalLine" WHERE "amount" <= 0;
--         must return 0 before this migration is applied to a live database.
--
-- Error codes: violations raise custom SQLSTATEs so callers can catch them
--         precisely — 'BL282' fiscal lock, 'BL295' posted-delete. (Not P0002
--         as suggested in review: P0002 is reserved — plpgsql no_data_found.)
--
-- Idempotency: functions are CREATE OR REPLACE; triggers and the constraint
--         are dropped-if-exists first, so re-running this file is safe.
--         Revert = DROP TRIGGER x2, DROP FUNCTION x2, DROP CONSTRAINT.
--
-- search_path: SET search_path FROM CURRENT pins each function's search_path
--         to the one active when the migration runs (the booklets schema via
--         DATABASE_URL ?schema=booklets). Without it, a direct client with a
--         different search_path would fire the trigger but fail to resolve
--         the unqualified "FiscalPeriod" reference.

-- ─── RAJ-282: fiscal-period lock ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION enforce_fiscal_period_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  closed_period_name TEXT;
BEGIN
  -- On UPDATE, only re-validate when the entry is actually being moved
  -- (date or organization changed). IS DISTINCT FROM is NULL-safe.
  IF TG_OP = 'UPDATE'
     AND NEW."date" IS NOT DISTINCT FROM OLD."date"
     AND NEW."organizationId" IS NOT DISTINCT FROM OLD."organizationId" THEN
    RETURN NEW;
  END IF;

  -- Target position: is the (new) date inside a closed period of the (new) org?
  SELECT fp."name" INTO closed_period_name
  FROM "FiscalPeriod" fp
  WHERE fp."organizationId" = NEW."organizationId"
    AND fp."startDate" <= NEW."date"
    AND fp."endDate"   >= NEW."date"
    AND (fp."isClosed" = true OR fp."locked" = true)
  LIMIT 1;

  IF closed_period_name IS NOT NULL THEN
    RAISE EXCEPTION 'Fiscal Integrity Violation: the date % falls within the closed fiscal period "%" — no entries may be added or moved there.',
      NEW."date", closed_period_name
      USING ERRCODE = 'BL282';
  END IF;

  -- Source position (UPDATE only): the entry may not be moved OUT of a closed
  -- period either — that silently rewrites locked-period financials.
  IF TG_OP = 'UPDATE' THEN
    SELECT fp."name" INTO closed_period_name
    FROM "FiscalPeriod" fp
    WHERE fp."organizationId" = OLD."organizationId"
      AND fp."startDate" <= OLD."date"
      AND fp."endDate"   >= OLD."date"
      AND (fp."isClosed" = true OR fp."locked" = true)
    LIMIT 1;

    IF closed_period_name IS NOT NULL THEN
      RAISE EXCEPTION 'Fiscal Integrity Violation: this entry belongs to the closed fiscal period "%" — it may not be moved out of it.',
        closed_period_name
        USING ERRCODE = 'BL282';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS journal_entry_fiscal_lock ON "JournalEntry";
CREATE TRIGGER journal_entry_fiscal_lock
  BEFORE INSERT OR UPDATE ON "JournalEntry"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_fiscal_period_lock();

-- ─── RAJ-295: POSTED entries are immutable — no DELETE ─────────────────────

CREATE OR REPLACE FUNCTION prevent_posted_entry_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  IF OLD."status" = 'POSTED' THEN
    RAISE EXCEPTION 'Audit Integrity Violation: posted journal entry % cannot be deleted. Void or reverse it to preserve the audit trail.',
      OLD."id"
      USING ERRCODE = 'BL295';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS journal_entry_no_posted_delete ON "JournalEntry";
CREATE TRIGGER journal_entry_no_posted_delete
  BEFORE DELETE ON "JournalEntry"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_posted_entry_delete();

-- ─── Hardening: JournalLine amounts strictly positive ──────────────────────
-- Sign lives in "isDebit"; amounts are always positive at every write site.

ALTER TABLE "JournalLine" DROP CONSTRAINT IF EXISTS "JournalLine_amount_positive";
ALTER TABLE "JournalLine"
  ADD CONSTRAINT "JournalLine_amount_positive" CHECK ("amount" > 0);
