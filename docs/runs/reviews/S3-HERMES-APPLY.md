# S3 (rls-lock) — Hermes apply & verify runbook (checkpoint 3a)

Branch: `claude/s3-rls-lock` · Migration: `prisma/migrations/20260712_rls_org_isolation/migration.sql`
Author: fable5-builder-s3 (FABLE5 autonomous run, service S3 / M3). Written **without live DB access** — every claim below about the live database must be verified here, not assumed.

Target: Supabase project `BookLets` (`euqdfxekrxnoibeahogq`, eu-west-1). Tables are believed to live in **`public`** (Message.md 2026-05-16: the `booklets` schema does not exist; the runtime `search_path=booklets,public` falls back). The migration self-detects the schema and aborts if `Organization` is in neither or both of `booklets`/`public`.

## What this delivers, in two phases

| Phase | What | Who is constrained | Risk if applied |
|---|---|---|---|
| 1 | Org-isolation policies on all 16 tenant tables + `booklets_current_org_id()` helper (the migration file) | Non-owner roles only (anon/authenticated/PostgREST). The app's owner connection still bypasses. | Near zero — non-owner roles were already fully locked out (RLS on, no policies). Policies only *permit* scoped access where there was none. |
| 2 | `FORCE ROW LEVEL SECURITY` on 15 tenant tables (SQL below; also commented at the bottom of the migration file) | **The app itself.** Owner bypass ends; every app query on a forced table needs `app.current_org_id` set in-transaction. | High if sequencing is wrong — see gate below. |

**Phase 2 gate (do not skip):** the Vercel deployment must be running the build from `claude/s3-rls-lock` (or later) **and** the app's read paths must have adopted `runWithOrgContext(...)`. As of this branch, WRITE paths are covered without any ambient scope: all six interactive transactions call `setRlsOrgContext(tx, organizationId)` with the org id passed **explicitly** (post-review change — the earlier build relied on an AsyncLocalStorage scope that most server actions never opened, making the call a no-op). READ paths still require `runWithOrgContext(...)` and only `trial-balance-report.ts` is wired as the exemplar. **Applying Phase 2 before the remaining server actions / pages are wired will blank every tenant page (fail closed to 0 rows), not leak data — and per the Phase 2 verification below, a blanked page is a HARD ABORT, not acceptable follow-up.** Phase 1 is safe to apply immediately.

### Phase 2 prerequisites (ALL must hold before any FORCE statement)

1. **Deployed build** is `claude/s3-rls-lock` or later (explicit-orgId `setRlsOrgContext`).
2. **Every read path is wired** with `runWithOrgContext(...)` — the full list is in "Open risks" item 1. If any page in the smoke test fails closed, Phase 2 must be rolled back immediately (see verification section).
3. **First-Organization creation:** the `Organization` policy's WITH CHECK requires `app.current_org_id` to EQUAL the new row's `id` at INSERT time. **No org-signup flow exists in the codebase today** (verified: no `organization.create` call anywhere in `src/`; orgs were seeded manually). Under FORCE, any operator or future signup code creating an organization MUST pre-generate the id (cuid — client-generatable) and set the GUC to that id inside the same transaction:
   ```sql
   BEGIN;
   SELECT set_config('app.current_org_id', '<pre-generated-new-org-id>', TRUE);
   INSERT INTO :"tenant_schema"."Organization" (id, name, slug, "createdAt", "updatedAt")
   VALUES ('<pre-generated-new-org-id>', '...', '...', now(), now());
   COMMIT;
   ```
   When a signup flow is built, it must pre-generate the id in application code and pass it through `setRlsOrgContext(tx, newOrgId)` before the INSERT — wire this requirement into that PR.
4. **Seeding is complete** — `prisma/seed.ts` sets no GUC and will fail closed after FORCE (risk 3).

### SQL convention — schema-qualify everything

The migration self-detects the hosting schema and reports it (`NOTICE: rls_org_isolation: applying policies in schema <name>`; expected `public`). Nothing below hardcodes a schema: every block uses the psql variable `tenant_schema`. Make this the FIRST statement of every psql session while working this runbook, using the schema the NOTICE named:

```sql
\set tenant_schema public
```

Identifier positions interpolate as `:"tenant_schema"` (e.g. `:"tenant_schema"."Property"`); string positions as `:'tenant_schema'`. If a block is run through the Supabase SQL editor instead of psql (no variable support), textually replace `:"tenant_schema"` with the quoted schema (e.g. `public`) and `:'tenant_schema'` with the quoted literal (e.g. `'public'`) first — never run a block with the placeholders unreplaced, and never "simplify" by dropping the qualification.

## Session-variable pattern (why it survives pgBouncer/Supavisor)

Policies key off `current_setting('app.current_org_id', true)` via the `STABLE` helper `booklets_current_org_id()` (`missing_ok=true` → NULL when unset; `nullif(…, '')` → empty string also NULL; NULL satisfies no predicate → **fail closed**).

The app sets the GUC **transaction-locally**: `SELECT set_config('app.current_org_id', $1, TRUE)` batched into the same implicit transaction as the query (Prisma extension), or issued as the first statement of an interactive transaction (`setRlsOrgContext(tx)`). Transaction-mode pooling hands the physical connection to another client after every transaction — a `SET SESSION` would leak tenant context across clients, and `SET LOCAL` outside an explicit transaction is a silent no-op. `set_config(..., TRUE)` inside the transaction that also runs the query is the only pattern that is correct under transaction pooling: the setting and the query share one connection and the setting dies at COMMIT/ROLLBACK.

**Apply this runbook over a DIRECT connection (port 5432), not the pooler (6543)** — the migration pins `search_path` session-locally after schema detection, which assumes one stable session.

## Phase 1 — apply the migration

Preferred (records it in `_prisma_migrations`, run from a checkout of the branch):

```bash
DATABASE_URL='postgresql://postgres:<PASSWORD>@db.euqdfxekrxnoibeahogq.supabase.co:5432/postgres' \
  npx prisma migrate deploy
```

Alternative A — plain psql (idempotent file; safe to re-run, but does NOT record in `_prisma_migrations` — `prisma migrate deploy` will then try to re-apply it later, which is harmless because the file is idempotent, but resolve it to keep history clean):

```bash
psql 'postgresql://postgres:<PASSWORD>@db.euqdfxekrxnoibeahogq.supabase.co:5432/postgres' \
  -v ON_ERROR_STOP=1 \
  -f prisma/migrations/20260712_rls_org_isolation/migration.sql
# then reconcile prisma's ledger:
npx prisma migrate resolve --applied 20260712_rls_org_isolation
```

Alternative B — Supabase MCP / SQL editor: paste the whole migration file as one `apply_migration` named `rls_org_isolation`, then `prisma migrate resolve --applied 20260712_rls_org_isolation` from a checkout.

Expected output includes: `NOTICE: rls_org_isolation: applying policies in schema public`.
**Verification item (schema mismatch):** if the NOTICE names `booklets`, or the migration aborts with the "BOTH schemas" exception, STOP — the schema layout changed since 2026-05-16; report back before proceeding.

## Phase 1 verification

### 1. Enumerate pg_policies per table (expect 16 rows, all named `org_isolation`)

```sql
\set tenant_schema public
SELECT schemaname, tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = :'tenant_schema'
ORDER BY tablename;
```

Expect exactly these 16 tables, `cmd = ALL`, and both `qual` and `with_check` non-NULL:
`Account, ActionIntentQueue, Booking, BookingCharge, EvidenceLog, Expense, FiscalPeriod, GuestPayout, JournalEntry, JournalLine, Membership, Organization, Owner, OwnerStatement, Property, PropertyOwnership`.
Expect NO policies on `User, Channel, ExpenseCategory, Vendor` (global tables — RLS enabled, deny-all for non-owner roles).

### 2. RLS enabled everywhere / forced nowhere yet

```sql
\set tenant_schema public
SELECT c.relname, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = :'tenant_schema' AND c.relkind = 'r'
ORDER BY c.relname;
```

Expect `rls_enabled = t` for all 20 tables, `rls_forced = f` for all (until Phase 2).

### 3. Cross-org SELECT returns 0 rows

There is currently one organization (`primary_org`). Create a throwaway second org and prove isolation with a NON-owner role (owner bypasses until Phase 2):

```sql
-- setup (as postgres)
\set tenant_schema public
INSERT INTO :"tenant_schema"."Organization" (id, name, slug, "createdAt", "updatedAt")
VALUES ('org_rls_probe', 'RLS Probe Org', 'rls-probe', now(), now());
INSERT INTO :"tenant_schema"."Property" (id, "organizationId", name, address, type, status, "createdAt", "updatedAt")
VALUES ('prop_rls_probe', 'org_rls_probe', 'Probe House', 'nowhere 1', 'APARTMENT', 'ACTIVE', now(), now());

CREATE ROLE rls_probe LOGIN PASSWORD '<probe-password>' NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA :"tenant_schema" TO rls_probe;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA :"tenant_schema" TO rls_probe;
```

```sql
-- as rls_probe (psql 'postgresql://rls_probe:<probe-password>@db...:5432/postgres')
\set tenant_schema public
-- First fetch the primary org id AS POSTGRES (a probe-role subselect would
-- itself be RLS-filtered): SELECT id FROM :"tenant_schema"."Organization" WHERE slug='primary_org';
BEGIN;
SELECT set_config('app.current_org_id', '<PRIMARY_ORG_ID>', TRUE);
SELECT count(*) FROM :"tenant_schema"."Property" WHERE "organizationId" = 'org_rls_probe';  -- MUST be 0
SELECT count(*) FROM :"tenant_schema"."Property";      -- only primary_org's 3 properties
SELECT count(*) FROM :"tenant_schema"."JournalEntry";  -- only primary_org's entries (10)
COMMIT;

BEGIN;
SELECT set_config('app.current_org_id', 'org_rls_probe', TRUE);
SELECT count(*) FROM :"tenant_schema"."Property";      -- MUST be 1 (only Probe House)
SELECT count(*) FROM :"tenant_schema"."JournalEntry";  -- MUST be 0
-- write fence: inserting into the OTHER org must fail with RLS violation:
INSERT INTO :"tenant_schema"."GuestPayout" (id, "organizationId", date, amount, status, "createdAt", "updatedAt")
VALUES ('gp_probe_x', '<PRIMARY_ORG_ID>', now(), 1, 'PENDING', now(), now());
-- expect: ERROR: new row violates row-level security policy
ROLLBACK;

BEGIN;   -- no GUC set at all → fail closed
SELECT count(*) FROM :"tenant_schema"."Property";      -- MUST be 0
COMMIT;
```

### 4. GUC does not leak across pooled transactions

Through the POOLER url (port 6543), run twice in separate connections/transactions:
```sql
SELECT current_setting('app.current_org_id', true);
```
Must be NULL/empty both times, including immediately after a probe transaction that set it (transaction-local scope proof).

## Phase 2 — FORCE (app-role lockdown) — only after ALL prerequisites above hold

```sql
\set tenant_schema public
-- Transactional DDL: any mid-step failure rolls the whole sequence back
-- instead of leaving FORCE half-applied across tables.
BEGIN;
ALTER TABLE :"tenant_schema"."Organization"      FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."Property"          FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."Owner"             FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."PropertyOwnership" FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."Account"           FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."JournalEntry"      FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."JournalLine"       FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."FiscalPeriod"      FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."Booking"           FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."BookingCharge"     FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."GuestPayout"       FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."OwnerStatement"    FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."Expense"           FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."EvidenceLog"       FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."ActionIntentQueue" FORCE ROW LEVEL SECURITY;
COMMIT;
-- Deliberately NOT forced: "User", "Membership" (sign-in upsert and
-- Membership→org resolution run BEFORE any org context can exist),
-- "Channel", "ExpenseCategory", "Vendor" (global reference data, no org path).
```

### Phase 2 verification — prove the app role cannot bypass

The app connects as the table owner (`postgres` on Supabase, which has **no** BYPASSRLS attribute — verify: `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user;` expect `f, f`). With FORCE on, the owner obeys the policies:

```sql
-- as postgres (the app role), direct connection:
\set tenant_schema public
BEGIN;  -- no GUC
SELECT count(*) FROM :"tenant_schema"."JournalEntry";   -- MUST be 0 (was 10 before FORCE)
SELECT count(*) FROM :"tenant_schema"."Property";       -- MUST be 0
COMMIT;

BEGIN;
SELECT set_config('app.current_org_id', '<PRIMARY_ORG_ID>', TRUE);
SELECT count(*) FROM :"tenant_schema"."JournalEntry";   -- MUST be 10 again
COMMIT;
```

### Phase 2 smoke test — pass/fail gate, NOT an observation exercise

Sign in to the deployed app and open **every** tenant-data page (dashboard, properties, bookings, ledger, approvals, reports/trial-balance, exports). Per the Phase 2 prerequisites, ALL read paths must already be wired with `runWithOrgContext` — so **every page must render its data**.

**Any page that renders empty/broken is a HARD ABORT of Phase 2.** Do not record it as "expected follow-up" and move on — a blanked page under FORCE means prerequisite 2 was not actually satisfied. Immediately run the Phase 2 rollback (the `NO FORCE` block below, which restores the owner bypass without weakening the Phase 1 policies), report which page failed, and only re-attempt FORCE after that path is wired and deployed.

### Cleanup of probe artifacts

The probe rows belong to `org_rls_probe`, so after FORCE even the owner connection needs the GUC set to delete them — wrap the deletes in a transaction that sets the org context first (this also works fine before FORCE):

```sql
\set tenant_schema public
BEGIN;
SELECT set_config('app.current_org_id', 'org_rls_probe', TRUE);
DELETE FROM :"tenant_schema"."Property" WHERE id = 'prop_rls_probe';
DELETE FROM :"tenant_schema"."Organization" WHERE id = 'org_rls_probe';
COMMIT;
REASSIGN OWNED BY rls_probe TO postgres; DROP OWNED BY rls_probe; DROP ROLE rls_probe;
```

## Rollback

Phase 2 only (returns the app's owner bypass, keeps anon locked out):

```sql
\set tenant_schema public
BEGIN;  -- transactional: all-or-nothing rollback of FORCE
ALTER TABLE :"tenant_schema"."Organization"      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."Property"          NO FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."Owner"             NO FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."PropertyOwnership" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."Account"           NO FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."JournalEntry"      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."JournalLine"       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."FiscalPeriod"      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."Booking"           NO FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."BookingCharge"     NO FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."GuestPayout"       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."OwnerStatement"    NO FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."Expense"           NO FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."EvidenceLog"       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE :"tenant_schema"."ActionIntentQueue" NO FORCE ROW LEVEL SECURITY;
COMMIT;
```

Full Phase 1 rollback (restores the exact pre-migration state: RLS enabled, zero policies):

```sql
\set tenant_schema public
BEGIN;  -- transactional: policies + helper function drop atomically
DROP POLICY IF EXISTS org_isolation ON :"tenant_schema"."Organization";
DROP POLICY IF EXISTS org_isolation ON :"tenant_schema"."Membership";
DROP POLICY IF EXISTS org_isolation ON :"tenant_schema"."Property";
DROP POLICY IF EXISTS org_isolation ON :"tenant_schema"."Owner";
DROP POLICY IF EXISTS org_isolation ON :"tenant_schema"."PropertyOwnership";
DROP POLICY IF EXISTS org_isolation ON :"tenant_schema"."Account";
DROP POLICY IF EXISTS org_isolation ON :"tenant_schema"."JournalEntry";
DROP POLICY IF EXISTS org_isolation ON :"tenant_schema"."JournalLine";
DROP POLICY IF EXISTS org_isolation ON :"tenant_schema"."FiscalPeriod";
DROP POLICY IF EXISTS org_isolation ON :"tenant_schema"."Booking";
DROP POLICY IF EXISTS org_isolation ON :"tenant_schema"."BookingCharge";
DROP POLICY IF EXISTS org_isolation ON :"tenant_schema"."GuestPayout";
DROP POLICY IF EXISTS org_isolation ON :"tenant_schema"."OwnerStatement";
DROP POLICY IF EXISTS org_isolation ON :"tenant_schema"."Expense";
DROP POLICY IF EXISTS org_isolation ON :"tenant_schema"."EvidenceLog";
DROP POLICY IF EXISTS org_isolation ON :"tenant_schema"."ActionIntentQueue";
DROP FUNCTION IF EXISTS :"tenant_schema".booklets_current_org_id();
COMMIT;
-- do NOT disable RLS: enabled-without-policies was the pre-existing state
-- (Supabase migration enable_rls_on_all_tables, 2026-05-16).
-- If rolled back via psql, also: npx prisma migrate resolve --rolled-back 20260712_rls_org_isolation
```

## Open risks / follow-ups for Hermes & the next builder

1. **Phase 2 blast radius**: the six interactive transactions now pass their org id to `setRlsOrgContext(tx, organizationId)` explicitly (write paths safe), but on the READ side only `trial-balance-report.ts` is wired. Before FORCE, wire `runWithOrgContext` into: `src/app/actions/{portfolio,property,bookings,ledger,receipt,approval,context,sync}.actions.ts`, `src/app/api/export/ledger/route.ts`, `src/lib/{pl-statement-report,balance-sheet-report}.ts`, and any server components querying prisma directly. Everything unwired fails closed (blank pages), not open — and a blank page in the Phase 2 smoke test is a HARD ABORT (see prerequisite 2 and the smoke-test gate), not tolerable follow-up.
2. **SymbiOS pre-checks under FORCE without context**: the fiscal-period/POSTED-delete pre-checks in `src/lib/prisma.ts` read via the RLS-scoped client; with no org context under FORCE they see 0 rows and pass — the DB triggers (`BL282`/`BL295`) and the RLS write policies remain the enforcing layer. Intended defence-in-depth ordering, but verify trigger behaviour under FORCE in Phase 2 smoke tests (attempt an INSERT into a closed period WITH the GUC set: expect `BL282`).
3. **Seed script** (`prisma/seed.ts`) connects as owner and sets no GUC — it will fail closed after Phase 2. Only relevant for fresh environments; run seeds before FORCE, or wrap seed writes in `set_config` transactions (follow-up).
4. **Org creation under FORCE**: `Organization`'s WITH CHECK requires the GUC to equal the new row's id — see **Phase 2 prerequisite 3** for the exact transaction pattern. No code path creates organizations today (verified); any future signup flow must pre-generate the cuid and call `setRlsOrgContext(tx, newOrgId)` before the INSERT.
5. **Schema mismatch** (Message.md follow-up #4): migration aborts on ambiguity instead of guessing. If the `booklets` schema is ever created and tables moved, re-run the migration (idempotent) so policies land in the right schema, and re-verify `pg_policies.schemaname`.
6. **Global tables** (`Channel`, `ExpenseCategory`, `Vendor`) are shared across orgs by schema design — cross-org reads of reference data remain possible for the app. If they become org-private, add `organizationId` + policy (schema change, new migration).
7. **Optional hardening** (not applied here): `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;` — PostgREST is unused by BookLets; policies now grant scoped access where a caller can set the GUC, and while PostgREST offers no way to set `app.*` GUCs, revoking the grants removes the question entirely.
8. **EvidenceLog hash chain is per-tenant** (`tenantId`), so org-scoped policies don't break chain verification; but any future global chain-audit job needs BYPASSRLS or per-org iteration with the GUC set.
