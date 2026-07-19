# Backup & Restore (RAJ-674)

Both independent go-live reviews (Qwen 3.7-max + Z.AI GLM 5.2, 2026-07-15) made a
**verified** backup a hard precondition for the single-tenant launch: an AI-authored
migration that corrupts the ledger must be recoverable. "A backup you have never
restored is not a backup," so the restore path is proven, not assumed.

## Before every risky change (migration / deploy)

```bash
# Use the DIRECT connection (port 5432), NOT the app's pooled 6543 URL.
# Supabase → Settings → Database → Connection string → URI.
BACKUP_DATABASE_URL='postgresql://postgres.<ref>:<pw>@<host>:5432/postgres' \
  ./scripts/backup-db.sh
# → backups/booklets-<timestamp>.dump
```

## Verify the dump is actually restorable (do this every time)

```bash
./scripts/restore-db.sh --verify-into-throwaway backups/booklets-<timestamp>.dump
# Spins up a local throwaway Postgres, restores, prints per-table row counts,
# then removes the throwaway. Touches no real database.
```

## Disaster recovery (destructive — only to recover)

```bash
./scripts/restore-db.sh --into 'postgresql://...:5432/postgres' backups/<dump>
# Refuses unless you type: RESTORE OVERWRITE
```

## Keeping the backup path trustworthy

`scripts/backup-restore-dryrun.sh` exercises the whole round-trip against throwaway
containers (seed → back up → restore → assert row counts survived). Run it after any
change to the backup scripts, or in CI. Requires Docker + libpq (`pg_dump`/`pg_restore`/
`psql`, e.g. `/opt/homebrew/opt/libpq/bin`).

**Proven 2026-07-16:** round-trip PASS — seeded 1 org + 2 accounts, backed up, restored
into a throwaway, counts matched.

## Notes / gotchas baked into the scripts
- `schema=` is a Prisma-only URL parameter; libpq tools reject it. The scripts strip it.
- Dumps use `-Fc --no-owner --no-privileges` so they restore across Supabase's differing
  roles without ownership errors.
- pg_dump needs a real session — never the pgbouncer transaction pooler (6543).
