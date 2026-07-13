# HR5-STEP0-BACKUP — pre-HR-5 restore capability (Checker gate artifact)

Requested by the Layer-1 Checker (DeepSeek, verdict BLOCK 2026-07-13): a committed,
fully-restorable backup of the `public` schema before any HR-5 DDL runs. This file
is the restore runbook; the three artifacts below are the backup.

## Artifacts (all committed under `docs/runs/backups/`)

| File | Role | sha256 |
|---|---|---|
| `2026-07-12-pre-hr5-schema.sql` | Complete DDL of the live `public` schema (pg_catalog-introspected 2026-07-12): tables, columns, defaults, constraints, indexes | `b27b8fa576b794476b889e9b1b5f77ccd98753723264478f31c44102bc69f1b9` |
| `2026-07-12-pre-hr5-data.json` | Every row of every `public` table (57 rows / 20 tables, snapshot 2026-07-12 23:33:03 UTC) | `aa1aa440589a0609b9b37b04d605c078f70402737dbebdd0264ef4dad76abe7b` |
| `2026-07-12-pre-hr5-restore.sql` | Single-command data restore: 57 `INSERT`s in FK-safe order inside one `BEGIN…COMMIT`, generated mechanically from the JSON | `5887e18207f08b6f21a67ffbecaa538a7fb8ad90d376447f9db8710619e36d05` |

## Freshness verification (read-only, 2026-07-13, Supabase)

Live per-table counts re-queried immediately before this file was written:
`Account=6, ActionIntentQueue=0, Booking=11, BookingCharge=0, Channel=3, EvidenceLog=0,
Expense=0, ExpenseCategory=0, FiscalPeriod=1, GuestPayout=0, JournalEntry=10,
JournalLine=20, Membership=1, Organization=1, Owner=0, OwnerStatement=0, Property=3,
PropertyOwnership=0, User=1, Vendor=0` — **total 57, identical to the snapshot.
Zero drift since capture.** If ANY write lands in prod between now and HR-5
execution, re-verify counts first; on mismatch, stop and re-snapshot.

## Restore procedure (full rollback of a failed/aborted HR-5)

HR-5 is a single transaction — a failed statement auto-rolls-back and NO restore is
needed. This procedure is for the disaster case only (e.g. someone splits the script
or the DB is otherwise damaged):

```bash
# 1. Rebuild schema (empty public schema — drop/recreate objects per file):
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/runs/backups/2026-07-12-pre-hr5-schema.sql
# 2. Reload all data (single transaction, FK-safe order):
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/runs/backups/2026-07-12-pre-hr5-restore.sql
# 3. Verify: per-table counts match the table above (total 57).
```

`raj_fin_track` is excluded by design — HR-5 never touches it (E6 boundary), so it
needs no restore path here.

## Checker conditions status

1. Committed restorable snapshot — **this file + artifacts. DONE.**
2. Enum cast verified on ALL `Account` rows — **DONE 2026-07-13, read-only:**
   `Account` has exactly 6 rows TOTAL (the earlier "6 rows" WAS the full table);
   0 rows with `type` outside the enum labels, 0 NULLs. The `USING` cast also
   fails loudly (transaction abort + rollback) on any unexpected value — the
   failure mode is a clean abort, never silent corruption.
3. Ordering: HR-5 → verify → HR-7. Note the app-health caveat: a 200 from
   `/api/health` also depends on Vercel env (#74 AUTH_URL diagnosis), so the
   post-HR-5 DB gate is the schema assertion query (new columns + enum + CHECK
   present), with the curl 200 tracked as a separate, env-dependent signal.
