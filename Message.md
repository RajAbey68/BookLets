# Message — agent-to-agent handoff

A lightweight log for Claude sessions running against this repo from
different machines to leave messages for each other. Append to the end;
do not rewrite or compact other agents' entries. Keep entries dated,
short, and concrete.

Convention: a section per session-turn, headed `### YYYY-MM-DD HH:MM — <agent-id-or-host> — <one-line subject>`.

---

### 2026-05-16 ~05:00 UTC — Claude (BookLets cwd, `process-handling` station) — release shipped + RLS hardened

**Status as of this entry:**

- `main` @ `f078ea4` (PR #27 merged). Production Vercel deployment
  `dpl_FSwrx7rg6NwAHhFcccx4tVC6qcBd` is READY.
- Production URL: `https://booklets-git-main-rajabey68s-projects.vercel.app`
- Supabase project `BookLets` (`euqdfxekrxnoibeahogq`, eu-west-1) is
  ACTIVE_HEALTHY. Schema is in `public` (not `booklets`); the runtime
  client's `search_path=booklets,public` falls back to `public` cleanly.
- 1 User, 1 Membership, 3 Properties, 6 Accounts, 10 JournalEntries,
  20 JournalLines, 1 FiscalPeriod, 3 Channels, 11 Bookings already in
  the DB. Someone (the operator) signed in and attached themselves to
  `primary_org` before I got here.

**What I just merged + applied:**

- **PR #26** — `AUTH_ALLOWED_EMAILS` allow-list in the `signIn`
  callback; fail-closed in production when the var is empty. Closes
  the open-door auth gap that existed when PR #12 merged without the
  allow-list commit. Plus `vercel.json nodeVersion` removed (schema
  rejected it); Node 20 pinned via `package.json#engines.node`.
- **PR #27** — Prisma 7 seed config (`migrations.seed` in
  `prisma.config.ts`), `@prisma/adapter-pg` wired into
  `prisma/seed.ts` with the same `-c search_path=booklets,public`
  options as the runtime client (Codex caught this; fixed in
  `203f105`). Added `db:migrate` / `db:seed` / `db:setup` scripts and
  `tsx` devDep so the DEPLOY.md runbook actually works.
- **PR #10 closed** as superseded — DEPLOY.md and Dockerfile bits
  already landed via other commits; only the residual seed fixes
  survived, which are now in PR #27.
- **Supabase migration `enable_rls_on_all_tables`** applied directly
  via the Supabase MCP. RLS now on for all 20 `public` tables; the
  Supabase REST API anon key can no longer read/write rows. The
  BookLets app's privileged Postgres connection (via the pg adapter)
  bypasses RLS and continues to work. **No policies added** — if
  the team ever wants to use PostgREST for anything (admin UI,
  webhooks, dashboards), add policies first.

**Open follow-ups for whoever picks up next:**

| | Item | Notes |
|---|---|---|
| 1 | Membership admin UI | Currently you `INSERT INTO public."Membership" (...)` by hand in Supabase SQL editor. Pre-built SQL snippet is in DEPLOY.md. |
| 2 | SoD enforcement (`makerIdentity !== checkerIdentity`) | `828703c` wired session identity into ledger writes. The check on `LedgerService.postEntry` / `reverseEntry` is the next step. |
| 3 | EvidenceLog hash-chain writes coverage | Service exists (`src/lib/evidence-log.service.ts`). Hooked into `postEntry` / `reverseEntry` per `c52ed8a`. Spot-check that every ledger write produces an evidence row in prod and that the chain hashes correctly. |
| 4 | Schema in `public` vs `booklets` | The runtime client requests `search_path=booklets,public` but `booklets` doesn't exist as a schema. Works today via the fallback. If anyone decides to actually create the `booklets` schema (e.g. to isolate from sibling apps in the shared Supabase project), every table has to move with a migration. |
| 5 | RLS policies (deferred) | RLS is on with no policies → anon role gets nothing. Acceptable for "team-of-4 internal tool". Revisit if you need to expose any read API to a wider audience. |
| 6 | Hostaway sync verification | If Hostaway creds are set in Vercel, `triggerManualSync` should be exercised end-to-end against the prod DB. The `SyncReport` shape will surface any per-record failures. |
| 7 | `/api/health` probe coverage | Added in `da99a4a`. Worth confirming it's pinged by a Vercel uptime check or external monitor. |

**What I cannot do from this environment (operator-side only):**

- Set / change Vercel env vars (no write tool exposed in Vercel MCP).
- Create Google OAuth clients (no Google MCP).
- Anything that requires a browser session (Stripe, Vercel dashboard
  clicks, etc.).

**Coordination notes:**

- This repo follows the lockboard in `AGENTS_LOG.md`: claim a scope
  before editing, branch as `claude/<short-purpose>`, open a draft PR,
  remove the block when it merges.
- `Message.md` (this file) is a separate, append-only channel for
  short status pings between sessions — not a replacement for the
  lockboard or PR flow.
- Operator's `Skool` integration lives in a different repo
  (`~/skool-mcp` on the operator's Mac); cross-service rules are in
  `docs/BRIEFING_FOR_OTHER_SERVICES.md`.

— end of entry —
