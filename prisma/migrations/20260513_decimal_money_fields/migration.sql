-- Migration: Float → Decimal on all monetary amount columns
-- Reason: IEEE-754 Float cannot represent decimal fractions exactly.
--         In a double-entry ledger, rounding errors compound across
--         thousands of transactions. Decimal(19,4) matches JournalLine.amount.
-- Affected: Booking.totalAmount, BookingCharge.amount, GuestPayout.amount,
--           OwnerStatement.totalDue, Expense.amount, PropertyOwnership.revenueShare

-- Booking
ALTER TABLE "Booking" ALTER COLUMN "totalAmount" TYPE DECIMAL(19,4) USING "totalAmount"::DECIMAL(19,4);

-- BookingCharge
ALTER TABLE "BookingCharge" ALTER COLUMN "amount" TYPE DECIMAL(19,4) USING "amount"::DECIMAL(19,4);

-- GuestPayout
ALTER TABLE "GuestPayout" ALTER COLUMN "amount" TYPE DECIMAL(19,4) USING "amount"::DECIMAL(19,4);

-- OwnerStatement
ALTER TABLE "OwnerStatement" ALTER COLUMN "totalDue" TYPE DECIMAL(19,4) USING "totalDue"::DECIMAL(19,4);

-- Expense
ALTER TABLE "Expense" ALTER COLUMN "amount" TYPE DECIMAL(19,4) USING "amount"::DECIMAL(19,4);

-- PropertyOwnership (revenue share: 0.0000–1.0000)
ALTER TABLE "PropertyOwnership" ALTER COLUMN "revenueShare" TYPE DECIMAL(5,4) USING "revenueShare"::DECIMAL(5,4);

-- PropertyOwnership: add missing indexes
CREATE INDEX IF NOT EXISTS "PropertyOwnership_propertyId_idx" ON "PropertyOwnership"("propertyId");
CREATE INDEX IF NOT EXISTS "PropertyOwnership_ownerId_idx" ON "PropertyOwnership"("ownerId");
