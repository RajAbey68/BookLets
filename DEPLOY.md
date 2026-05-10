# Deploying BookLets

This runbook covers a first-time deployment to **Google Cloud Run + Cloud SQL** (the
target the existing `cloudbuild.yaml` is wired for) and the day-1 setup steps to get
the app actually usable.

> **Status of the codebase as of `bbcf03b`:** `tsc --noEmit` clean, `npm run build`
> passes, no auth/session yet (uses the seeded `primary_org`). PR #2 (UI primitives)
> and PR #5 (Float → Decimal money columns) are still open and worth merging
> before public use, but neither blocks deployment.

## What you need before you start

| | |
|---|---|
| GCP project | with Cloud Run, Cloud Build, Cloud SQL (Postgres 16+), Artifact Registry, Secret Manager, and Serverless VPC Access enabled |
| Region | `europe-west1` (set in `cloudbuild.yaml`; change there if different) |
| Cloud SQL instance | Postgres 16, with a database called `booklets` and a user with full DDL rights on it |
| VPC connector | named `booklets-connector` in `europe-west1` (referenced in `cloudbuild.yaml`); the connector must reach the Cloud SQL instance |
| Hostaway sandbox or live | `client_id`, `client_secret`, `account_id` |
| `GEMINI_API_KEY` | for the AI receipt extraction (or whatever provider you're routing through SymbiOS) |

## 1. Put secrets in Secret Manager

`cloudbuild.yaml` references these names:

```bash
gcloud secrets create DATABASE_URL          --replication-policy=automatic
gcloud secrets create GEMINI_API_KEY        --replication-policy=automatic
gcloud secrets create HOSTAWAY_CLIENT_ID    --replication-policy=automatic
gcloud secrets create HOSTAWAY_CLIENT_SECRET --replication-policy=automatic
gcloud secrets create HOSTAWAY_ACCOUNT_ID   --replication-policy=automatic
```

Then add a version to each:

```bash
echo -n 'postgresql://booklets:PASSWORD@/booklets?host=/cloudsql/PROJECT:europe-west1:INSTANCE' \
  | gcloud secrets versions add DATABASE_URL --data-file=-
echo -n 'sk_live_...' | gcloud secrets versions add GEMINI_API_KEY --data-file=-
# ...same for the three HOSTAWAY_* secrets
```

The Cloud Run service account needs `roles/secretmanager.secretAccessor` on each.

## 2. Initialise the database (one-time)

The repo currently has **no migration history** (`prisma/migrations/` does not
exist; the first migration lands with PR #5). For the very first install, push
the schema directly:

```bash
# Locally, with DATABASE_URL pointing at the Cloud SQL instance via the proxy:
cloud-sql-proxy PROJECT:europe-west1:INSTANCE &
DATABASE_URL='postgresql://booklets:PASSWORD@127.0.0.1:5432/booklets' \
  npx prisma db push
```

After PR #5 merges, switch to `npm run db:migrate` (which runs
`prisma migrate deploy`) and never go back to `db push` against production.

## 3. Seed the database (one-time)

```bash
DATABASE_URL='postgresql://booklets:PASSWORD@127.0.0.1:5432/booklets' \
  npm run db:seed
```

This creates:
- Organisation `primary_org` (`Asimov Lettings Portfolio`)
- The full chart of accounts, including suspense (`9999`) and primary bank (`1000`)
- A fiscal period for the current year
- The three booking channels (Airbnb, Booking.com, Direct)

The app will refuse to sync without a chart of accounts, so this step is required.

You can re-run the seed safely; everything is `upsert`.

## 4. Deploy

```bash
gcloud builds submit --config cloudbuild.yaml
```

`cloudbuild.yaml` builds the Docker image, pushes it to GCR, and deploys to
Cloud Run with secrets attached and the VPC connector wired up.

The Dockerfile uses Node 20 and `npm ci` so builds are deterministic and
match the engines required by Next 16 + Prisma 7.

## 5. Smoke-test the deployment

After Cloud Run reports the revision live:

1. Open the service URL.
2. The home page should load (currently no auth — directly resolves the
   `primary_org`).
3. `/properties` should render the empty state ("Sync your Hostaway account
   or add properties manually to see analytics").
4. `/ledger` should render "No ledger entries found".
5. `/bookings` is a static placeholder.
6. Hit the **Sync Hostaway** button in the sidebar. With valid Hostaway
   credentials, this will fetch reservations and populate the ledger. With
   no credentials and `STRICT_HOSTAWAY` unset, it falls back to two mock
   reservations so you can see the flow.

If sync returns `{ success: false, message: 'Organization "..." has no chart of accounts. Run the seed before syncing.' }`,
you skipped step 3. Run it.

## 6. Verify the sync produced ledger entries

```sql
SELECT je.id, je.memo, je.status, je.date,
       jl."isDebit", jl.amount, a.name AS account
FROM "JournalEntry" je
JOIN "JournalLine" jl ON jl."journalEntryId" = je.id
JOIN "Account" a ON a.id = jl."accountId"
ORDER BY je."createdAt" DESC
LIMIT 20;
```

You should see balanced debit/credit pairs against `Operating Cash` /
`Guest Pre-payments` (initial booking funds) and, for any reservation
where `checkOut` is in the past, against `Guest Pre-payments` /
`Rental Income` (recognition).

## What's not in scope of this runbook

- **Auth/session.** Currently every request resolves to `primary_org` via
  `prisma.organization.findFirst()`. Don't expose this to multiple tenants
  yet. Tracked in `AGENTS_LOG.md` "Out of scope".
- **EvidenceLog hash-chain writes.** Service exists (PR #4) but is not yet
  wired into `LedgerService`. Tracked.
- **SoD (maker ≠ checker).** Blocked on auth/session.
- **Visual polish.** Pending PR #2.
- **Decimal precision on every money column.** Pending PR #5.

## Operational notes

- **Token timeouts:** `EXTERNAL_FETCH_TIMEOUT_MS` (default 30000) controls
  the timeout on Hostaway and SymbiOS calls.
- **Strict mode:** set `STRICT_HOSTAWAY=true` to fail loudly when credentials
  are missing instead of falling back to mock data. Recommended for
  production.
- **Build cache:** the Dockerfile copies the Prisma schema into the runtime
  image so `prisma migrate deploy` can be run from the container if you ever
  need to. The Cloud Run service won't run migrations on its own; that's a
  manual step.
