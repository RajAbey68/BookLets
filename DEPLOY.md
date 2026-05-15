# Deploying BookLets

BookLets supports multiple deployment shapes. For a small accounting team
(operator + bookkeeper + a few accountants) the recommended target is
**Vercel + Neon + Google OAuth via Auth.js**. The original `cloudbuild.yaml`
that targets GCP Cloud Run is retained as an alternative.

> **Status of the codebase:** `tsc --noEmit` clean, `npm run build` passes,
> end-to-end sync verified against a real Postgres. Real auth/session is
> **not yet implemented** — every request currently resolves to the seeded
> `primary_org` via `prisma.organization.findFirst()`. Don't expose the app
> to multiple humans until the auth PR lands.

## Local development

Useful for any developer working on BookLets, regardless of which production
target you pick.

```bash
# 1. Start Postgres in the background.
docker compose up -d postgres

# 2. Install deps.
npm ci

# 3. Push the schema and seed the chart of accounts.
export DATABASE_URL='postgresql://booklets:booklets_dev_2024@localhost:5432/booklets'
npx prisma db push        # use `npm run db:migrate` once PR #5 lands the first migration
npm run db:seed

# 4. Run.
npm run dev               # http://localhost:3000 with hot reload
# or
npm run build && npm start
```

The "Verify the sync produced ledger entries" SQL at the bottom of this file
works the same way against your local Postgres.

---

## Production target: Vercel + Neon + Google OAuth

This is the recommended path for a small remote team.

### What you need

| | |
|---|---|
| Vercel account | Hobby tier is enough for a 3–5 user team |
| Neon account | Free tier: 0.5 GB Postgres + 7-day branches for cheap point-in-time recovery |
| Google Cloud project | Only to host the OAuth Client ID (no GCP compute) |
| Hostaway credentials | `client_id`, `client_secret`, `account_id` |
| `GEMINI_API_KEY` | for the AI receipt extraction (whatever provider SymbiOS routes through) |

### Step 1. Neon — provision Postgres

1. Create a Neon project. Pick the region closest to your team.
2. Copy the **pooled** connection string. It looks like
   `postgresql://USER:PASSWORD@ep-xxxxx-pooler.region.aws.neon.tech/booklets?sslmode=require`.
3. From a local shell (or the Neon SQL editor), apply the schema:
   ```bash
   DATABASE_URL='<pooled-conn-string>' npx prisma db push
   DATABASE_URL='<pooled-conn-string>' npm run db:seed
   ```
   (Switch to `npm run db:migrate` once the first migration lands in `prisma/migrations/`.)

### Step 2. Google — create the OAuth client

1. In Google Cloud Console → APIs & Services → Credentials, create an
   **OAuth 2.0 Client ID** of type *Web application*.
2. Authorised redirect URIs:
   - `https://<your-vercel-domain>/api/auth/callback/google`
   - `http://localhost:3000/api/auth/callback/google` (for local testing)
3. Note the Client ID and Client Secret.
4. Configure the OAuth consent screen — *Internal* if you have Workspace
   (restricts to your domain), otherwise *External* with the team's Gmail
   addresses added as test users until you publish.

### Step 3. Vercel — connect the repo

1. Vercel → New Project → import the `RajAbey68/BookLets` repo. Auto-detects
   Next.js. Use the default build command (`next build`).
2. Set Environment Variables (Project Settings → Environment Variables):

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | Neon pooled connection string |
   | `AUTH_SECRET` | a random 32-byte string: `openssl rand -base64 32` |
   | `AUTH_GOOGLE_ID` | the Google OAuth Client ID |
   | `AUTH_GOOGLE_SECRET` | the Google OAuth Client Secret |
   | `AUTH_ALLOWED_EMAILS` | **comma-separated email allow-list** (e.g. `alice@example.com,bob@example.com`). Only listed emails can sign in. Production deploys without this var refuse every sign-in by design — set it. |
   | `HOSTAWAY_CLIENT_ID` | Hostaway |
   | `HOSTAWAY_CLIENT_SECRET` | Hostaway |
   | `HOSTAWAY_ACCOUNT_ID` | Hostaway |
   | `GEMINI_API_KEY` | SymbiOS / Gemini |
   | `STRICT_HOSTAWAY` | `true` for production |

3. Deploy. Vercel will run `npm ci` and `next build`.

### Step 4. Invite team members

Once the auth PR lands:

1. Each user signs in once via Google. Their first sign-in creates a `User`
   row.
2. The operator (you) attaches users to the `primary_org` via the membership
   admin UI (also pending the auth PR).
3. Until the membership UI exists, attach users directly in the DB:
   ```sql
   INSERT INTO "Membership" ("userId", "organizationId", "role")
   VALUES ('<user-id>', 'primary_org', 'BOOKKEEPER');
   ```

### Step 5. Smoke-test the deployment

1. Open the Vercel URL.
2. You'll be redirected to Google sign-in.
3. After consent, the dashboard loads. `/properties` and `/ledger` show
   empty states. `/bookings` is a static placeholder.
4. Hit **Sync Hostaway** in the sidebar. With valid Hostaway credentials,
   this fetches reservations and posts the deferred-revenue + recognition
   entries. With no credentials and `STRICT_HOSTAWAY` unset, it falls back
   to two mock reservations.

### Backups on Neon

- Neon free tier: create a branch from any point in the last 7 days; promote
  it as the new primary if you ever need to roll back. Branch operation is
  near-instant and free.
- Neon Launch ($19/mo): adds automatic point-in-time recovery up to 30 days.

Releases via `git push` trigger a Vercel deploy. **Vercel deploys never touch
Neon** — your database is preserved across releases by definition.

---

## Alternative: Cloud Run + Cloud SQL

The repo also ships `cloudbuild.yaml` for a GCP deployment. Pick this if you
already have a GCP estate or want Identity-Aware Proxy for authentication
instead of Auth.js.

### What you need

| | |
|---|---|
| GCP project | with Cloud Run, Cloud Build, Cloud SQL (Postgres 16+), Artifact Registry, Secret Manager, and Serverless VPC Access enabled |
| Region | `europe-west1` (set in `cloudbuild.yaml`; change there if different) |
| Cloud SQL instance | Postgres 16, with a database called `booklets` and a user with DDL rights |
| VPC connector | named `booklets-connector` in `europe-west1` |

### Steps

```bash
# 1. Put secrets in Secret Manager.
gcloud secrets create DATABASE_URL          --replication-policy=automatic
gcloud secrets create GEMINI_API_KEY        --replication-policy=automatic
gcloud secrets create HOSTAWAY_CLIENT_ID    --replication-policy=automatic
gcloud secrets create HOSTAWAY_CLIENT_SECRET --replication-policy=automatic
gcloud secrets create HOSTAWAY_ACCOUNT_ID   --replication-policy=automatic

echo -n 'postgresql://booklets:PASSWORD@/booklets?host=/cloudsql/PROJECT:europe-west1:INSTANCE' \
  | gcloud secrets versions add DATABASE_URL --data-file=-
# ...same for the other secrets

# 2. Apply the schema (via cloud-sql-proxy).
cloud-sql-proxy PROJECT:europe-west1:INSTANCE &
DATABASE_URL='postgresql://booklets:PASSWORD@127.0.0.1:5432/booklets' npx prisma db push
DATABASE_URL='postgresql://booklets:PASSWORD@127.0.0.1:5432/booklets' npm run db:seed

# 3. Deploy.
gcloud builds submit --config cloudbuild.yaml
```

For multi-user auth on this path, either:
- gate the Cloud Run URL behind Identity-Aware Proxy with Google accounts, or
- use Auth.js the same way as the Vercel path (deploy steps are independent
  of the auth choice).

---

## Verify the sync produced ledger entries

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
`Guest Pre-payments` (initial booking funds) and, for reservations whose
`checkOut` is in the past, against `Guest Pre-payments` / `Rental Income`
(recognition).

## Out of scope of this runbook

- **Auth/session.** Currently every request resolves to `primary_org` via
  `prisma.organization.findFirst()`. The Vercel section above describes
  the configuration that the auth PR will require; **the deployment
  is not multi-user-safe until that PR lands.**
- **SoD (maker ≠ checker).** Blocked on auth/session.
- **Decimal precision on every money column.** Pending PR #5.

## Operational notes

- **`EXTERNAL_FETCH_TIMEOUT_MS`** (default `30000`) controls the timeout on
  Hostaway and SymbiOS calls.
- **`STRICT_HOSTAWAY=true`** fails loudly when Hostaway credentials are
  missing instead of falling back to mock data. Recommended for production.
- **`prisma migrate deploy`** is a manual step — no platform runs it
  automatically. Wire it into a Vercel post-deploy hook or a Cloud Build
  step once you have migration history.
