# BookLets — Architecture Review & Risk Register

> Honest audit of the current architecture. Companions:
> [`01-current-state.md`](01-current-state.md),
> [`02-target-state.md`](02-target-state.md).

This is a critical read, not a celebration. The system works at the
operator's current scale; some of what's flagged below would matter
if the operating context changed (multi-tenant, multi-region, multi-
operator). Each item carries a **severity** (P0 = ship-stopper today,
P1 = fix before P2 lands, P2 = fix before multi-tenant) and a
**recommendation**.

---

## Strengths (so we know what to preserve)

- **Server-first.** Reads are Server Components fetched in parallel —
  no over-eager client hydration, no waterfall fetches.
- **Edge-safe auth.** Splitting `auth.config.ts` (Edge) from `auth.ts`
  (Node) is the correct shape for Auth.js v5 + Prisma 7.
- **Idempotency built in from day one.** `JournalEntry.sourceHash` is
  designed before P2 ships — the spreadsheet importer won't double-post.
- **Multi-tenant by construction.** `orgId` on every domain row even
  though we run single-tenant today. Promotion is a config flip, not a
  rewrite.
- **Documentation is in-repo and versioned.** HELP / LLM-ASSISTANT /
  this architecture pack live next to the code that implements them.
- **Decimal everywhere on money.** No floating-point arithmetic on
  currency values inside the parser or the seed.

---

## Risk register

### R1 · Single-region database — **P2**
Supabase Postgres is in `eu-west-1`; the operator is in Sri Lanka.
Latency for the bookkeeper from APAC is acceptable for typed work but
poor for heavy iteration. Cold reads can take 400–800 ms.

**Recommendation:** stay single-region until multi-operator scaling
demands more. When that happens, evaluate Supabase read-replicas in
APAC before standing up a second primary.

---

### R2 · No structured logging or alerting — **P1**
The codebase uses `console.log`. Vercel captures these but there's no
JSON parsing, no error grouping, no on-call alerting. A failing
import would surface only when the operator notices missing rows.

**Recommendation:** add `pino` and a Vercel-compatible transport
before P2 ships. Add Sentry (or equivalent) for client + server
exceptions at the same time. Both are one-PR changes.

---

### R3 · RLS coverage is implicit — **P2**
Postgres RLS is enabled at the database level, but the application
relies on Prisma to scope every query by `orgId`. There is no defence
in depth — a missing `WHERE org_id = ?` in a server action would not
be caught by RLS unless every policy is explicitly written.

**Recommendation:** audit RLS policies on every domain table before
promoting to multi-tenant. Write a test that connects with a
non-owner JWT and confirms zero rows return on cross-org queries.
Track the audit in a follow-up issue tagged `security/rls`.

---

### R4 · Server Action serialization is fragile — **P1**
We already shipped one bug where `Decimal` instances crossed the
Server Action boundary (commit `f1b91eb` fixed it). Prisma model
classes have the same risk. There's no type-level guard preventing
this — a developer can return `result` containing a Decimal and TS
won't complain because the deep type passes `JSON.stringify`-shape
checks.

**Recommendation:** add a `Serializable<T>` brand type and a lint
rule that flags Server Action return shapes containing forbidden
class instances. Until then, every action MUST go through a
`serialize*` helper that returns plain primitives.

---

### R5 · No background-job infrastructure — **P1 (blocks P8)**
Everything is request-scoped. P4 (bank reconciliation polling), P5
(month-close FX snapshot fetch), and especially P8 (Drive watcher +
OCR pipeline) need a long-running worker.

**Recommendation:** before P4, evaluate Inngest, Trigger.dev, or
Vercel Cron + Vercel Queue. Pick one and write the abstraction
once. Don't put OCR in a Vercel serverless function — the 60 s
hard timeout will bite.

---

### R6 · Spreadsheet parser hard-codes the operator's workbook — **P2**
`COLUMN_TO_ACCOUNT` in `src/lib/spreadsheet-parser.ts` is a static map
of the operator's exact column headers. A second operator with a
different workbook layout would require code changes.

**Recommendation:** if BookLets becomes multi-operator, lift the
mapping into the `Organization` row as a JSONB column. The parser
loads the org's mapping at parse time. Defer until needed.

---

### R7 · Hostaway is the single source of bookings — **P2**
We have one channel manager integration. If Hostaway is down for a
day, the operator types bookings manually. There's no fallback feed
and no diff/repair workflow if Hostaway and BookLets get out of sync.

**Recommendation:** add a reconcile-bookings background job that
flags discrepancies (Hostaway has it; BookLets doesn't, or vice
versa). Run nightly. Defer until P2 ships.

---

### R8 · Secrets sprawl in `.env.example` — **P2**
The example file lists `DATABASE_URL`, `AUTH_SECRET`, `AUTH_GOOGLE_*`,
`AUTH_ALLOWED_EMAILS`, and optional `HOSTAWAY_*`, `GOOGLE_GEMINI_*`.
As more integrations land, the env-var list grows linearly and the
chance of a misconfigured deploy grows with it.

**Recommendation:** when secret count crosses ~12, move to a config
loader (`zod` + structured env validation) that fails on boot with a
clear error. Until then, the example file is sufficient.

---

### R9 · No CSP / security headers — **P2**
`next.config.ts` doesn't set Content-Security-Policy, Strict-Transport-
Security, or frame-ancestors. Default Next.js + Vercel headers are not
enough for a finance app.

**Recommendation:** add a security-headers middleware (or
`next.config.ts` `headers()` function) before going beyond single-
operator. Use `helmet`-equivalent defaults. One PR.

---

### R10 · The chart of accounts is seeded, not user-editable — **P2**
36 lines in `prisma/seed.ts`. Adding a 37th requires a code change +
deploy. The bookkeeper can't add a new account themselves.

**Recommendation:** lift `Account` to a real CRUD table with an
admin UI before multi-operator. The seeded list becomes the
*default* for a new org.

---

### R11 · No data lifecycle / archival policy — **P3**
Journal entries, bookings, and expenses grow monotonically. At Ko
Lake scale this is years away from mattering, but there's no
explicit policy on retention or archival.

**Recommendation:** document a retention policy (probably "forever,
this is an accounting record") in `docs/policies/`. Add a partitioning
plan to `02-target-state.md` if the table sizes ever cross 10 M rows.

---

### R12 · LLM grounding leaks if not tested — **P1 (when P9 lands)**
The system prompt in `docs/LLM-ASSISTANT.md` *tells* the LLM to refuse
out-of-scope questions. There's no automated test that *verifies* it
does. The first time the in-app chat hallucinates a number, trust is
gone.

**Recommendation:** before P9 ships, write a regression test suite of
~30 prompts (legit + out-of-scope + adversarial) and gate every model
upgrade on it. Use a deterministic temperature setting in production.

---

### R13 · No DR / restore drill — **P2**
Supabase takes daily backups. Nobody has restored from one. If the
database is corrupted, recovery is untested.

**Recommendation:** run a restore drill quarterly. Pick a recent
backup, restore to a sandbox project, run the app against it, confirm
the ledger matches.

---

### R14 · Cold-start latency on Vercel serverless — **P3**
First request to a cold Lambda runs Prisma client init (~400–800 ms
extra). With the operator's low call frequency, every visit is
basically a cold start.

**Recommendation:** measure before optimising. If it stays under 2 s
total, fine. If it climbs, options are: Vercel Edge Functions for
read-only routes, or Fluid Compute / dedicated containers for the app.

---

### R15 · Build secret leakage — **P2**
`prisma migrate deploy` runs in the Vercel build. If a future change
adds a step that logs the connection string, the secret lands in
build logs which are stored.

**Recommendation:** add a CI check that scans Vercel build logs for
common secret shapes (basic regex). One follow-up issue.

---

## Critical-path summary (ordered)

The list below is what I'd fix in order before piling more features on:

1. **R4** — Server Action serialization brand type / lint rule. *One PR.*
2. **R2** — Structured logging + Sentry. *One PR.*
3. **R5** — Pick the background-job platform and write the abstraction. *One PR + design.*
4. **R12** — LLM grounding regression test suite (only when P9 starts). *Build alongside P9.*
5. **R3** — RLS audit and cross-org test. *Before multi-tenant.*
6. **R9** — Security headers middleware. *Before multi-tenant.*
7. **R10** — User-editable chart of accounts. *Before multi-operator.*

Everything else is correctly deferred — none of it blocks today's
operator from using BookLets correctly, and the architecture supports
fixing each item later without a rewrite.

---

## What I'd push back on if someone proposed it

- "Let's add Redis for caching." — No measured cache need yet. Adds an
  operational surface for no win. Revisit when a query is provably
  slow under load that won't be solved by an index.
- "Let's switch to GraphQL." — Server Actions cover today's needs.
  GraphQL would force a client cache and complicate auth. Not until
  the system grows public-API consumers.
- "Let's add a separate microservice for receipts." — One Next.js
  process. P8's heavy work goes to a background worker, not to a new
  service.
- "Let's run our own LLM." — See `02-target-state.md` §9. Not until
  cost or data-residency forces our hand.
- "Let's add Mongo for the chat history." — See `02-target-state.md`
  §8. JSONB on a single `ChatTurn` table beats two stores.
