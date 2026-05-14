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
2. In **SQL Editor**, ensure the `booklets` schema exists:
   ```sql
   CREATE SCHEMA IF NOT EXISTS booklets;
   ```
3. Copy the **Transaction** connection string from  
   Settings → Database → Connection string → Transaction mode  
   (port **6543**, not 5432).

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

Click **Deploy**. The `postinstall` hook runs `prisma generate` automatically.

---

## 4 — Run the database migration + seed

From your local machine with `DATABASE_URL` in your environment:

```bash
# Push the schema to Supabase (first deploy only)
npx prisma db push

# Seed demo data: 3 properties, 11 bookings, 10 journal entries
npm run db:seed
```

> `db:seed` is defined in `package.json` as `npx prisma db seed`.

---

## 5 — First sign-in and membership

1. Open your Vercel URL and sign in with Google.
2. You'll be redirected back to `/` — but the dashboard will be empty because your user has no org membership yet.
3. In Supabase **SQL Editor**, run:

```sql
INSERT INTO booklets."Membership" (id, "userId", "organizationId", role, "createdAt", "updatedAt")
SELECT
  gen_random_uuid(),
  u.id,
  o.id,
  'OWNER',
  now(),
  now()
FROM booklets."User" u, booklets."Organization" o
WHERE u.email = '<your-google-email>'
  AND o.slug   = 'default';
```

4. Refresh the app — the dashboard now shows your organisation name and seeded metrics.

---

## Local development

```bash
cp .env.example .env.local
# Fill in .env.local with your values

npm ci
npx prisma generate
npx prisma db push      # or db:migrate once migrations exist
npm run db:seed
npm run dev
```

App runs at [http://localhost:3000](http://localhost:3000).

---

## Health check

```
GET /api/health
→ 200 {"status":"ok","db":"reachable"}      # DB up
→ 503 {"status":"degraded","db":"unreachable"} # DB down
```

Use this URL as the uptime monitor endpoint.
