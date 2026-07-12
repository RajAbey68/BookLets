# MIGRATION BASELINE PLAN — prod DB `euqdfxekrxnoibeahogq` (schema `public`)
> Verified 2026-07-12 by Fable via read-only Supabase connector (Raj-authorized).
> Purpose: make the merged code actually run in prod (currently 500) and stop
> merged PRs being dead code at runtime. HERMES executes the write steps; every
> mutating step is gated on a fresh backup + human review of generated DDL.

## 1. VERIFIED LIVE STATE (read-only facts, not the auditor's word)
| Signature | Migration | Present in prod? |
|---|---|---|
| Booking.totalAmount = numeric | 20260513_decimal_money_fields | ✅ YES |
| Account.parentId | 20260701_account_hierarchy | ❌ NO |
| JournalEntry.idempotencyKey | 20260701_journal_idempotency_key | ❌ NO |
| JournalEntry.version | 20260701_journal_optimistic_lock | ❌ NO |
| AccountType enum type | 20260703_account_type_enum_org_parent | ❌ NO (Account.type exists but NOT as the enum) |
| ActionIntentQueue.organizationId | 20260703_action_intent_org_scope | ❌ NO |
| JournalEntry.source/sourceId | 20260703_journal_source_fields | ❌ NO |
| fiscal-lock / posted-delete triggers | 20260703_fiscal_lock_and_posted_delete_triggers | ❌ NO (none of the present triggers are BookLets') |
| composite query indexes | 20260703_composite_query_indexes | ⚠️ UNVERIFIED (47 indexes exist; names not diffed) |
| RLS policies | (PR #76, unmerged) | ❌ 0 policies (RLS enabled, none defined) |

**Root facts:**
- **No `_prisma_migrations` table** → prod was built with `prisma db push`, NOT `migrate deploy`. There is zero migration history. Standard `migrate deploy` will FAIL (it would try to apply migration #1 from scratch onto existing tables).
- Prod `public` sits at roughly the **pre-20260701 baseline**: 20 base tables + decimal money, but NONE of the July schema evolution (hierarchy, idempotency, optimistic-lock, enum, org-scope, source fields, triggers).
- `AccountType` enum missing is the direct cause of the `booklets.vercel.app` 500 (runtime "type public.AccountType does not exist").
- **`booklets` schema does not exist** — prisma search_path `booklets,public` silently resolves to `public`. Fine for now, but the S3 runbook's schema-detection must resolve to `public`.
- ⚠️ **Non-BookLets object present:** a trigger `trg_prevent_auction_delete` exists in this DB — from an unrelated app. This DB is NOT a clean single-app database; treat all DDL with extra care and back up first.

## 2. WHY "just apply the 9 migrations" IS WRONG
- No history + db-push drift means `migrate deploy` has no baseline and will conflict.
- `migrate diff --from-url <prod> --to-schema-datamodel schema.prisma` captures only schema.prisma-modeled objects — it will MISS the raw-SQL triggers (migration 8) and RLS policies (PR #76), which live in migration.sql, not schema.prisma.

## 3. RECOMMENDED MECHANISM (Strategy B — diff-to-target + full baseline)
Executed by Hermes against the prod DB, over a DIRECT connection (:5432, not the pooler), in a transaction, backup first:

**Step 0 — Backup.** `pg_dump` the `public` schema (schema+data) to a timestamped file. Do not proceed without it.

**Step 1 — Corrective schema DDL: ALREADY GENERATED AND REVIEWED.**
Use [`MIGRATION-BASELINE-DDL.sql`](./MIGRATION-BASELINE-DDL.sql) (this directory) — do not regenerate.
It was produced on 2026-07-12 by replaying the read-only-introspected live prod DDL into a
local shadow Postgres 16 and diffing with `prisma migrate diff --from-config-datasource
--to-schema prisma/schema.prisma --script` (Prisma 7 removed `--from-url`; the config-datasource
form reads `DATABASE_URL` from env via prisma.config.ts). The one destructive statement Prisma
emitted (DROP/re-ADD of `Account.type`) was rewritten as a lossless in-place enum cast —
live values verified as a subset of the enum labels. Applying the corrected script to the
shadow and re-diffing yields "No difference detected", so it provably reaches schema.prisma's
exact end-state. If prod drifts again before execution, regenerate via the same shadow method
and re-review; anything destructive → STOP.

**Step 2 — Apply the raw-SQL that diff can't see**, from the repo migration files, made idempotent (IF NOT EXISTS / CREATE OR REPLACE):
  - `prisma/migrations/20260703_fiscal_lock_and_posted_delete_triggers/migration.sql` (the fiscal-lock + posted-delete triggers).
  - After PR #76 merges: `prisma/migrations/20260712_rls_org_isolation/migration.sql` (RLS policies — Phase 1 only; FORCE stays Phase 2 per S3-HERMES-APPLY.md).

**Step 3 — Baseline history** so future deploys are clean:
```
for m in 20260513_decimal_money_fields 20260701_account_hierarchy \
  20260701_journal_idempotency_key 20260701_journal_optimistic_lock \
  20260703_account_type_enum_org_parent 20260703_action_intent_org_scope \
  20260703_composite_query_indexes 20260703_fiscal_lock_and_posted_delete_triggers \
  20260703_journal_source_fields ; do
  npx prisma migrate resolve --applied "$m" ; done
```
(This writes `_prisma_migrations` marking all 9 as applied, since Steps 1–2 brought prod to their combined end-state.)

**Step 4 — Verify (read-only):** re-run the §1 signature query → every row YES; `curl -i https://booklets.vercel.app/api/health` → 200 (enum now exists). Then a smoke query of a report page.

## 4. HARD CAVEATS
- **Do not touch `raj_fin_track`** in this operation — separate concern (the S1 receipts live there; the app never reads it — that's the pipeline-bridge decision, tracked separately).
- Every step is Hermes-executed on the devserver/direct connection per E6; Fable does not run the writes.
- If Step 1's diff proposes anything destructive to existing rows (10 JournalEntry rows, 1 org), STOP and escalate — do not auto-apply.
