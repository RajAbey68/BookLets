-- Convert all monetary columns from DOUBLE PRECISION (Float) to NUMERIC(19, 4)
-- to eliminate floating-point precision loss in money arithmetic.
-- JournalLine.amount was already NUMERIC(19, 4); the columns below are the
-- remaining Float money columns flagged in AGENTS_LOG.md.

ALTER TABLE "Booking"
  ALTER COLUMN "totalAmount" SET DATA TYPE DECIMAL(19, 4)
  USING "totalAmount"::numeric;

ALTER TABLE "Expense"
  ALTER COLUMN "amount" SET DATA TYPE DECIMAL(19, 4)
  USING "amount"::numeric;

ALTER TABLE "BookingCharge"
  ALTER COLUMN "amount" SET DATA TYPE DECIMAL(19, 4)
  USING "amount"::numeric;

ALTER TABLE "GuestPayout"
  ALTER COLUMN "amount" SET DATA TYPE DECIMAL(19, 4)
  USING "amount"::numeric;

ALTER TABLE "OwnerStatement"
  ALTER COLUMN "totalDue" SET DATA TYPE DECIMAL(19, 4)
  USING "totalDue"::numeric;
