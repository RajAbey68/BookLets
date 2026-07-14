# Deploying BookLets

## Prerequisites

| What | Where |
|---|---|
| Supabase project | [supabase.com](https://supabase.com) — free tier is sufficient |
| Google OAuth client | [console.cloud.google.com](https://console.cloud.google.com) → APIs & Services → Credentials |
| Vercel account | [vercel.com](https://vercel.com) — free Hobby plan works |

---

## 1 — Supabase setup

1. Create a new project (note your database password).
2. Copy the **Transaction** connection string from  
   Settings → Database → Connection string → Transaction mode  
   (port **6543**, not 5432).

> **Schema note (verify against your project before relying on this):** `src/lib/prisma.ts`
> documents the intent that all tables live in a `booklets` Postgres schema, reached by
> setting `search_path` via the connection. However `prisma/schema.prisma` has no
> `@@schema` mapping, so a plain `prisma db push`/`migrate deploy` creates tables in
> whichever schema your connection's `search_path` resolves to first — `public` by
> default. Do **not** pre-create an empty `booklets` schema and assume the app uses it;
> confirm with `\dt` (or `SELECT schemaname, tablename FROM pg_tables WHERE tablename =
> 'Organization'`) which schema your tables actually land in after step 4, and set
> `search_path` accordingly if you need `booklets` specifically.

---

## 2 — Google OAuth

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**.
2. Application type: **Web application**.
3. Authorised redirect URIs — add:
   ```
   https://<your-vercel-url>/api/auth/callback/google
   ```
   You can add `http://localhost:3000/api/auth/callback/google` for local dev.
4. Copy the **Client ID** and **Client Secret**.

---

## 3 — Deploy to Vercel

```
vercel.com/new → Import Git Repository → RajAbey68/BookLets
```

Set these environment variables in the Vercel dashboard before the first deploy:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `postgresql://postgres.[ref]:[password]@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&schema=booklets` |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `AUTH_GOOGLE_ID` | From step 2 |
| `AUTH_GOOGLE_SECRET` | From step 2 |
| `AUTH_ALLOWED_EMAILS` | **Comma-separated email allow-list** (e.g. `alice@example.com,bob@example.com`). Only listed emails can sign in. Production deploys without this var refuse every sign-in by design — set it. |

Click **Deploy**. The `postinstall` hook runs `prisma generate` automatically.

---

## 4 — Run the database migration

From your local machine with `DATABASE_URL` in your environment:

```bash
# 1. Schema baseline. `prisma migrate deploy` alone FAILS against a fresh
#    database — this repo's migration history has no baseline migration (the
#    earliest one ALTERs columns on tables it never created), so the tables
#    must exist first via db push.
npx prisma db push

# 2. Raw-SQL migrations `prisma db push` cannot express — the fiscal-period
#    lock trigger, the posted-entry-immutability trigger, the amount>0 CHECK
#    constraint, and the RLS org-isolation policies. Get psql from your
#    Supabase connection string (Settings → Database → Connection string →
#    psql), or use the SQL Editor and paste each file's contents.
psql "$DATABASE_URL" -f prisma/migrations/20260703_fiscal_lock_and_posted_delete_triggers/migration.sql
psql "$DATABASE_URL" -f prisma/migrations/20260712_rls_org_isolation/migration.sql
```

> This exact two-step procedure is proven against a real Postgres container in
> `scripts/test-integration-setup.sh` (RAJ-674) — it is not a guess.

```bash
# 3. Structural scaffolding the app cannot run without: an Organization,
#    chart of accounts, fiscal period, and channels. Safe to run against
#    production ONLY as of PR #87 (RAJ-674) — before that PR merges,
#    prisma/seed.ts ALSO creates demo properties/bookings/POSTED journal
#    entries that will show up on the dashboard as if they were genuine
#    activity. That is exactly how the "Marina Suite / Temple Bar Loft /
#    Coastal Cottage" incident happened. Confirm #87 is merged before
#    running this against a real deploy; if it isn't, create the
#    Organization/Account/FiscalPeriod/Channel rows by hand instead.
npm run db:seed
```

---

## 5 — First sign-in and membership

1. Open your Vercel URL and sign in with Google.
2. You'll be redirected back to `/` — but the dashboard will be empty because your user has no org membership yet.
3. In Supabase **SQL Editor**, run (schema-qualify `"Membership"`/`"User"`/`"Organization"`
   with whichever schema step 1 confirmed your tables actually landed in — omit the
   prefix entirely if that's `public`, since it's on the default `search_path`):

```sql
INSERT INTO "Membership" (id, "userId", "organizationId", role, "createdAt", "updatedAt")
SELECT
  gen_random_uuid(),
  u.id,
  o.id,
  'OWNER',
  now(),
  now()
FROM "User" u, "Organization" o
WHERE u.email = '<your-google-email>'
  AND o.slug   = 'default';
```

4. Refresh the app — the dashboard now shows your organisation name. Property and
   booking data populates as real activity is created or synced (Hostaway, receipt
   upload, manual entry) — the seed step above intentionally creates no demo
   properties/bookings as of PR #87.

---

## Local development

```bash
cp .env.example .env.local
# Fill in .env.local with your values

npm ci
npx prisma generate
npx prisma db push
npm run db:seed
npm run dev
```

App runs at [http://localhost:3000](http://localhost:3000).

> This gives you a working app, but **without** the fiscal-lock/posted-delete triggers
> or RLS policies from step 4 above — those are optional for local development, but if
> you're testing anything that depends on them, apply the same two `psql -f` commands
> against your local database, or run `npm run test:integration:setup` (RAJ-674) which
> does this automatically against an ephemeral Docker Postgres.

---

## Health check

```
GET /api/health
→ 200 {"status":"ok","db":"reachable"}      # DB up
→ 503 {"status":"degraded","db":"unreachable"} # DB down
```

Use this URL as the uptime monitor endpoint.
