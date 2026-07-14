<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Go-live operating facts (BookLets)

- **Properties are intentionally empty.** Raj does NOT want mock/demo data
  seeded. There are **8 real Ko Lake units** that will be pulled in due
  course. An empty dashboard + hidden receipt uploader is EXPECTED until the
  real units land — it is not a bug. Never run `prisma db seed` (demo Dublin
  properties) against production.
- **DB schema:** app tables live in Postgres `public` schema. `prisma.ts`
  sets `search_path=booklets,public`; the `booklets` schema does not exist, so
  it falls through to `public`. Do not create a `booklets` schema — it would
  split the data.
- **Prod migration baseline:** production is applied through `20260703_*`.
  The `20260712_rls_org_isolation` and `20260713_sandbox_dedup_blocker`
  migrations exist on branch `claude/prompt-looping-setup-tvqczj` only and are
  NOT yet applied to prod.
- **Sandbox dedup is a hard gate.** Ko Lake payments were imported multiple
  times across batches; nothing may be promoted to `public.JournalEntry` until
  the dedup blocker migration is applied and duplicates are resolved.
