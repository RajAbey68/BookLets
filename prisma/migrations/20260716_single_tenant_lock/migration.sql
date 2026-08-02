-- Migration: RAJ-674 — DB-level single-tenant lock
--
-- Reason: two independent non-Anthropic reviews (Qwen 3.7-max + Z.AI GLM 5.2,
--         2026-07-15) flagged an app-layer `ALLOW_MULTI_TENANCY` env check as
--         "dangerously incomplete": Prisma connects as a privileged role, so
--         a raw SQL insert, a Supabase SQL-editor statement, or a future
--         migration could add a second Organization and silently defeat the
--         containment the whole single-tenant go-live posture depends on. The
--         lock must live in the database, where it cannot be bypassed by the
--         application layer.
--
-- Behaviour: BEFORE INSERT on "Organization" — allow the FIRST organization
--         (the owner's own books), hard-abort every subsequent one. This is
--         the containment that caps the blast radius of the AI-authored,
--         not-yet-human-audited ledger/RLS code to the owner's own data while
--         the app is single-tenant and pre-revenue.
--
-- Going multi-tenant is therefore a DELIBERATE, REVIEWED act: dropping this
--         trigger (see the paired 20260716_single_tenant_unlock migration,
--         intentionally NOT applied) — which, per the reviewers, is exactly
--         the moment a human DBA must also apply FORCE ROW LEVEL SECURITY and
--         audit the money paths. An env var could be flipped by accident; a
--         migration drop cannot.
--
-- search_path: SET search_path FROM CURRENT so the function resolves
--         "Organization" in the same schema the rest of the app uses (matches
--         the fiscal-lock / RLS migrations' convention).
--
-- Idempotent: CREATE OR REPLACE FUNCTION; DROP TRIGGER IF EXISTS first.

CREATE OR REPLACE FUNCTION enforce_single_tenant()
  RETURNS TRIGGER
  SET search_path FROM CURRENT
  AS $$
DECLARE
  existing_count BIGINT;
BEGIN
  SELECT count(*) INTO existing_count FROM "Organization";
  IF existing_count > 0 THEN
    RAISE EXCEPTION
      'Single-tenant lock: a second Organization may not be created. This '
      'deployment is intentionally single-tenant (RAJ-674). Going multi-tenant '
      'is a deliberate act: drop trigger organization_single_tenant_lock via a '
      'reviewed migration, and apply FORCE ROW LEVEL SECURITY + a human money-'
      'path audit at the same time.'
      USING ERRCODE = 'BL674';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS organization_single_tenant_lock ON "Organization";
CREATE TRIGGER organization_single_tenant_lock
  BEFORE INSERT ON "Organization"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_single_tenant();
