-- Migration: S3 (rls-lock) — organisation-isolation RLS policies for every tenant table
-- Run/spec: FABLE5 autonomous run, service S3 / M3. Apply + verify runbook:
--           docs/runs/reviews/S3-HERMES-APPLY.md (checkpoint 3a).
--
-- Background (Message.md 2026-05-16 entry): RLS was ENABLED on all tables via
--         the Supabase migration `enable_rls_on_all_tables`, but NO policies
--         exist. That locks out the anon/PostgREST surface (no policy = deny
--         for non-owner roles) while the app's owner connection bypasses RLS
--         entirely. This migration adds the actual org-isolation policies so
--         (a) any non-owner role is scoped to exactly one organisation, and
--         (b) once FORCE ROW LEVEL SECURITY is applied (Phase 2, see below),
--         the app's own connection is scoped too.
--
-- Session-variable pattern: every policy keys off
--         current_setting('app.current_org_id', true)
--         (missing_ok = true → NULL when unset, and NULL never satisfies a
--         policy predicate → FAIL CLOSED: no context, no rows).
--         The app sets it TRANSACTION-LOCALLY, never session-wide:
--           SELECT set_config('app.current_org_id', '<orgId>', TRUE);
--         batched/executed inside the same transaction as the query
--         (src/lib/prisma.ts `rls-org-context` extension, and
--         setRlsOrgContext(tx) inside interactive transactions).
--         Transaction-local is mandatory: Supabase's pooler (pgBouncer /
--         Supavisor) in transaction mode reassigns the physical connection
--         after every transaction, so a session-level GUC would leak one
--         tenant's org id onto another client's connection. A transaction-
--         local GUC cannot outlive its transaction, so it is pool-safe.
--
-- Schema resolution (public vs booklets): the runtime client requests
--         search_path=booklets,public but the tables live in `public` today
--         (the `booklets` schema does not exist; Message.md follow-up #4).
--         Rather than guess, the DO block below DETECTS the schema hosting
--         "Organization" and pins search_path for the rest of this
--         migration. It raises (aborting the migration) if the table is
--         found in NEITHER or in BOTH schemas — ambiguity must be resolved
--         by a human/Hermes, not silently. HERMES VERIFICATION ITEM: confirm
--         the detection NOTICE names the expected schema (`public`).
--
-- Idempotency: ALTER TABLE ... ENABLE ROW LEVEL SECURITY is naturally
--         idempotent; functions are CREATE OR REPLACE; every policy is
--         DROP POLICY IF EXISTS'd first. Re-running this file is safe.
--
-- Rollback: see docs/runs/reviews/S3-HERMES-APPLY.md (drops the policies and
--         the helper function; RLS itself stays enabled — that was the
--         pre-existing state).
--
-- Table → isolation-path map (all 20 Prisma models):
--   TENANT, direct org column (policy on own column):
--     Organization       id            (the tenant root row itself)
--     Membership         organizationId  [bootstrap table — see Phase 2 note]
--     Property           organizationId
--     Owner              organizationId
--     Account            organizationId
--     JournalEntry       organizationId
--     FiscalPeriod       organizationId
--     GuestPayout        organizationId
--     EvidenceLog        tenantId      (ledger.service writes organizationId here)
--     ActionIntentQueue  organizationId (nullable — NULL rows are invisible by
--                                        design, RAJ-292: "invisible and
--                                        undecidable rather than cross-tenant")
--   TENANT, via join path (policy is an EXISTS over the parent chain):
--     PropertyOwnership  propertyId → Property.organizationId
--     JournalLine        journalEntryId → JournalEntry.organizationId
--     Booking            propertyId → Property.organizationId
--     BookingCharge      bookingId → Booking.propertyId → Property.organizationId
--     OwnerStatement     ownerId → Owner.organizationId
--     Expense            propertyId → Property.organizationId
--   GLOBAL / NO TENANT PATH (RLS stays enabled, NO org policy possible):
--     User               cross-org identity; reaches orgs only via Membership.
--                        An org policy would break the pre-auth sign-in upsert.
--     Channel            shared reference data (Airbnb/Booking.com/...); no
--                        org column; Bookings of every org point at it.
--     ExpenseCategory    shared reference data; no org column.
--     Vendor             shared reference data; no org column.
--                        (Follow-up: if vendors/categories ever become
--                        org-private, add organizationId + policy then.)
--
-- Phase 2 (NOT executed here — see the commented FORCE block at the bottom):
--         the app connects as the table OWNER, and owners bypass RLS unless
--         FORCE ROW LEVEL SECURITY is set. FORCE is deliberately left to the
--         Hermes runbook because it must only be applied after the app build
--         that sets `app.current_org_id` (this branch) is live, or every
--         tenant-table query from the app would fail closed to zero rows.

-- ─── Schema detection: target the schema the tables actually live in ───────

DO $$
DECLARE
  org_schemas text[];
BEGIN
  SELECT array_agg(n.nspname ORDER BY n.nspname)
  INTO org_schemas
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relname = 'Organization'
    AND c.relkind = 'r'
    AND n.nspname IN ('booklets', 'public');

  IF org_schemas IS NULL THEN
    RAISE EXCEPTION 'rls_org_isolation: table "Organization" found in neither the booklets nor the public schema — wrong database or search_path? Aborting.';
  ELSIF array_length(org_schemas, 1) > 1 THEN
    RAISE EXCEPTION 'rls_org_isolation: table "Organization" exists in BOTH booklets and public — the schema split must be resolved by an operator before applying RLS policies (see docs/runs/reviews/S3-HERMES-APPLY.md). Aborting.';
  END IF;

  -- Session-local pin (is_local = false): survives to the end of this
  -- connection whether the file is applied by `prisma migrate deploy`
  -- (single transaction) or by psql statement-by-statement.
  PERFORM set_config('search_path', quote_ident(org_schemas[1]), false);
  RAISE NOTICE 'rls_org_isolation: applying policies in schema %', org_schemas[1];
END $$;

-- ─── Helper: the org id of the current request context (or NULL) ───────────
-- STABLE so the planner evaluates it once per statement. missing_ok=true →
-- NULL when the GUC was never set; nullif() also maps '' to NULL so an
-- accidentally-empty setting cannot match anything either. NULL fails closed.

CREATE OR REPLACE FUNCTION booklets_current_org_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('app.current_org_id', true), '')
$$;

-- ─── Enable RLS on every table (idempotent; already on since 2026-05-16) ───

ALTER TABLE "Organization"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Membership"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Property"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Owner"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PropertyOwnership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Account"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "JournalEntry"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "JournalLine"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FiscalPeriod"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Channel"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Booking"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BookingCharge"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GuestPayout"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OwnerStatement"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExpenseCategory"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Vendor"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Expense"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EvidenceLog"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ActionIntentQueue" ENABLE ROW LEVEL SECURITY;

-- ─── Org-isolation policies: direct org-column tables ───────────────────────
-- FOR ALL + identical USING / WITH CHECK: reads see only the active org's
-- rows, and writes may neither create nor move rows outside the active org.

DROP POLICY IF EXISTS org_isolation ON "Organization";
CREATE POLICY org_isolation ON "Organization"
  FOR ALL
  USING ("id" = booklets_current_org_id())
  WITH CHECK ("id" = booklets_current_org_id());

DROP POLICY IF EXISTS org_isolation ON "Membership";
CREATE POLICY org_isolation ON "Membership"
  FOR ALL
  USING ("organizationId" = booklets_current_org_id())
  WITH CHECK ("organizationId" = booklets_current_org_id());

DROP POLICY IF EXISTS org_isolation ON "Property";
CREATE POLICY org_isolation ON "Property"
  FOR ALL
  USING ("organizationId" = booklets_current_org_id())
  WITH CHECK ("organizationId" = booklets_current_org_id());

DROP POLICY IF EXISTS org_isolation ON "Owner";
CREATE POLICY org_isolation ON "Owner"
  FOR ALL
  USING ("organizationId" = booklets_current_org_id())
  WITH CHECK ("organizationId" = booklets_current_org_id());

DROP POLICY IF EXISTS org_isolation ON "Account";
CREATE POLICY org_isolation ON "Account"
  FOR ALL
  USING ("organizationId" = booklets_current_org_id())
  WITH CHECK ("organizationId" = booklets_current_org_id());

DROP POLICY IF EXISTS org_isolation ON "JournalEntry";
CREATE POLICY org_isolation ON "JournalEntry"
  FOR ALL
  USING ("organizationId" = booklets_current_org_id())
  WITH CHECK ("organizationId" = booklets_current_org_id());

DROP POLICY IF EXISTS org_isolation ON "FiscalPeriod";
CREATE POLICY org_isolation ON "FiscalPeriod"
  FOR ALL
  USING ("organizationId" = booklets_current_org_id())
  WITH CHECK ("organizationId" = booklets_current_org_id());

DROP POLICY IF EXISTS org_isolation ON "GuestPayout";
CREATE POLICY org_isolation ON "GuestPayout"
  FOR ALL
  USING ("organizationId" = booklets_current_org_id())
  WITH CHECK ("organizationId" = booklets_current_org_id());

-- EvidenceLog's tenant column is "tenantId"; ledger.service.ts writes the
-- organizationId into it (tenantId ?? organizationId on every write path).
DROP POLICY IF EXISTS org_isolation ON "EvidenceLog";
CREATE POLICY org_isolation ON "EvidenceLog"
  FOR ALL
  USING ("tenantId" = booklets_current_org_id())
  WITH CHECK ("tenantId" = booklets_current_org_id());

-- ActionIntentQueue.organizationId is nullable (retrofitted column). A NULL
-- org id never equals the GUC → org-less intents are invisible under RLS,
-- exactly the RAJ-292 semantics ("invisible and undecidable, not cross-tenant").
DROP POLICY IF EXISTS org_isolation ON "ActionIntentQueue";
CREATE POLICY org_isolation ON "ActionIntentQueue"
  FOR ALL
  USING ("organizationId" = booklets_current_org_id())
  WITH CHECK ("organizationId" = booklets_current_org_id());

-- ─── Org-isolation policies: join-path tables ───────────────────────────────
-- The EXISTS subqueries reference parent tables that carry their own RLS
-- policies; those nested policies filter to the same org id, so the nested
-- evaluation is consistent (never wider) with the direct predicate.

DROP POLICY IF EXISTS org_isolation ON "PropertyOwnership";
CREATE POLICY org_isolation ON "PropertyOwnership"
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM "Property" p
    WHERE p."id" = "PropertyOwnership"."propertyId"
      AND p."organizationId" = booklets_current_org_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "Property" p
    WHERE p."id" = "PropertyOwnership"."propertyId"
      AND p."organizationId" = booklets_current_org_id()
  ));

DROP POLICY IF EXISTS org_isolation ON "JournalLine";
CREATE POLICY org_isolation ON "JournalLine"
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM "JournalEntry" je
    WHERE je."id" = "JournalLine"."journalEntryId"
      AND je."organizationId" = booklets_current_org_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "JournalEntry" je
    WHERE je."id" = "JournalLine"."journalEntryId"
      AND je."organizationId" = booklets_current_org_id()
  ));

DROP POLICY IF EXISTS org_isolation ON "Booking";
CREATE POLICY org_isolation ON "Booking"
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM "Property" p
    WHERE p."id" = "Booking"."propertyId"
      AND p."organizationId" = booklets_current_org_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "Property" p
    WHERE p."id" = "Booking"."propertyId"
      AND p."organizationId" = booklets_current_org_id()
  ));

DROP POLICY IF EXISTS org_isolation ON "BookingCharge";
CREATE POLICY org_isolation ON "BookingCharge"
  FOR ALL
  USING (EXISTS (
    SELECT 1
    FROM "Booking" b
    JOIN "Property" p ON p."id" = b."propertyId"
    WHERE b."id" = "BookingCharge"."bookingId"
      AND p."organizationId" = booklets_current_org_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM "Booking" b
    JOIN "Property" p ON p."id" = b."propertyId"
    WHERE b."id" = "BookingCharge"."bookingId"
      AND p."organizationId" = booklets_current_org_id()
  ));

DROP POLICY IF EXISTS org_isolation ON "OwnerStatement";
CREATE POLICY org_isolation ON "OwnerStatement"
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM "Owner" o
    WHERE o."id" = "OwnerStatement"."ownerId"
      AND o."organizationId" = booklets_current_org_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "Owner" o
    WHERE o."id" = "OwnerStatement"."ownerId"
      AND o."organizationId" = booklets_current_org_id()
  ));

DROP POLICY IF EXISTS org_isolation ON "Expense";
CREATE POLICY org_isolation ON "Expense"
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM "Property" p
    WHERE p."id" = "Expense"."propertyId"
      AND p."organizationId" = booklets_current_org_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "Property" p
    WHERE p."id" = "Expense"."propertyId"
      AND p."organizationId" = booklets_current_org_id()
  ));

-- ─── Global tables: NO org policy (deliberate) ──────────────────────────────
-- "User", "Channel", "ExpenseCategory", "Vendor" have no organisation path.
-- RLS stays ENABLED with no policy → non-owner roles (anon/authenticated via
-- PostgREST) are denied everything, unchanged from the 2026-05-16 lockout.
-- The app's owner connection continues to read them (RLS not FORCEd on
-- these four even in Phase 2 — "User"/"Membership" are required before an
-- org context can exist: sign-in upsert and Membership → org resolution).

-- ─── Phase 2 (Hermes-applied, checkpoint 3a): make the APP obey the policies ─
-- The app role is the table owner; owners bypass RLS unless FORCE is set.
-- Apply ONLY after the app build that sets `app.current_org_id` per
-- transaction (branch claude/s3-rls-lock) is deployed, or the app will fail
-- closed to zero rows on every tenant table. Kept here commented-out as the
-- canonical statement list; executable steps + verification + rollback live
-- in docs/runs/reviews/S3-HERMES-APPLY.md.
--
-- ALTER TABLE "Organization"      FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "Property"          FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "Owner"             FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "PropertyOwnership" FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "Account"           FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "JournalEntry"      FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "JournalLine"       FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "FiscalPeriod"      FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "Booking"           FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "BookingCharge"     FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "GuestPayout"       FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "OwnerStatement"    FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "Expense"           FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "EvidenceLog"       FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "ActionIntentQueue" FORCE ROW LEVEL SECURITY;
-- -- NOT forced: "User", "Membership" (auth bootstrap runs before any org
-- -- context exists), "Channel", "ExpenseCategory", "Vendor" (global
-- -- reference data with no org path).
