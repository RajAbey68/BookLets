-- Ko Lake's books are kept in Sri Lankan rupees. Both currency columns carried
-- a default of 'EUR', inherited from the project's original scaffold.
--
-- The import paths were never affected: ocr-bridge.ts and statement-ingest.ts
-- both pass currency: 'LKR' explicitly on every line they write. The default
-- only bites a writer that omits the column -- which is exactly what
-- RevenueService.getOrCreateAccount did, stamping every auto-created account
-- 'EUR' while every line posted against it was 'LKR'.
--
-- DEFAULT ONLY. Existing rows are deliberately left alone: this migration must
-- not rewrite historical currency, because a row that genuinely is EUR is
-- indistinguishable here from one that merely inherited the default. Any
-- backfill needs eyes on the data first (see the audit query below).
ALTER TABLE "Account"     ALTER COLUMN "currency" SET DEFAULT 'LKR';
ALTER TABLE "JournalLine" ALTER COLUMN "currency" SET DEFAULT 'LKR';

-- Audit before considering a backfill:
--   SELECT currency, COUNT(*) FROM "JournalLine" GROUP BY currency;
--   SELECT currency, COUNT(*) FROM "Account"     GROUP BY currency;
