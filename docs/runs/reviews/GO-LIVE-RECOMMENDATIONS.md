# GO-LIVE RECOMMENDATIONS — BookLets (for third-party review)
# Author: claude-opus (Fable), 2026-07-14. Verified against live main + live DB.
# Reviewers: run through Gemini 3.5 Pro + GLM 5.2 (and Hermes). Attack each REC.

## STATE OF THE WORLD (verified, not assumed)
- `main` builds and is healthy: has adm-zip, `src/proxy.ts` (no stale root
  middleware), the ingest backend (`/api/ingest/zip`, `/api/ingest/ocr-bridge`,
  `zip-ingest.ts`, `ocr-bridge.ts`), and the RLS migration FILE
  `20260712_rls_org_isolation`.
- Prod DB migrations applied stop at `20260703_*`. So `20260712_rls_org_isolation`
  is committed to main but NOT applied to the prod database. RLS FORCE is
  deliberately deferred, so an unapplied RLS migration does not break anything
  today (policies simply don't exist yet; the app behaves as it does now).
- Prod has: 1 Organization, 1 User (rajabey68@gmail.com), 1 Membership (login
  works), 0 Properties (INTENTIONAL — 8 real Ko Lake units land later), suspense
  account seeded, 0 journal entries.
- `sandbox.payment_entries`: 128 rows, ZERO duplicates by any key; gross LKR
  11.69M is a true single-count (the "triple-count" theory was refuted).
- Open PRs: #84 (`s11-sandbox-books-ui`, UI only, +1472 lines) and #71
  (orchestration branch: docs, review packets, preventive dedup migration,
  branch-local build fixes).

## REC 1 — Merge #84 → main. This is the go-live action.
- RECOMMEND: merge PR #84 into main.
- BASIS: #84 is the ONLY thing standing between you and a usable app. It adds the
  Sandbox/Books two-tab UI, `ZipUploadCard` (the file-upload UI you've been
  asking for), `FeedIntoBooksButton`, and the ledgers view. It merges into main
  with NO conflicts and adds NO database migration, so it cannot corrupt data.
- CONSEQUENCE IF NOT: you have no interface to upload files or view ledgers; the
  backend sits unused.
- BENEFIT: after merge + Vercel deploy, you log in (already works) and can upload
  your first WhatsApp export zip into the sandbox pile on the live site.
- RESIDUAL RISK for reviewers to probe: does `ZipUploadCard` post to the real
  `/api/ingest/zip` route, and does the upload path work with 0 Properties (it
  should — zip ingest lands in the sandbox pile, not against a property)? Confirm
  before declaring "usable".

## REC 2 — Do NOT apply any DB migration for go-live.
- RECOMMEND: go live on the current prod schema; apply `20260712_rls_org_isolation`
  and the preventive `20260713_sandbox_dedup_blocker` LATER, as a separate
  Hermes-gated step (direct :5432 connection, not the pooler).
- BASIS: #84 needs no migration. RLS FORCE is deferred by design; applying it now
  adds risk (app connects as table owner) for zero go-live benefit. The dedup
  blocker is PREVENTIVE only — sandbox has no duplicates today.
- CONSEQUENCE IF NOT: applying RLS/dedup now injects schema risk into a go-live
  with no offsetting benefit.
- BENEFIT: smallest possible change surface for first live use.

## REC 3 — Disposition of #71 (my orchestration branch): do not merge wholesale.
- RECOMMEND: keep #71 as the record branch; land only its durable docs
  (AGENTS.md go-live facts) and the corrected `20260713` dedup migration when
  the dedup step in REC 2 is scheduled. Drop the branch-local build fixes — main
  does not need them (already has adm-zip, proxy, no dup middleware).
- BASIS: #71 is an orchestration/spec/bus branch, not a feature branch. Merging it
  wholesale into main would drag spec + run-logs + review packets into product
  history for no runtime benefit.
- CONSEQUENCE IF NOT: noisy main history; possible churn on `ocr-bridge.deps.ts`
  which #84 also edits.
- BENEFIT: main stays feature-focused; #71's value (notes + preventive migration)
  is preserved and lands deliberately.

## REC 4 — After #84 is live, verify the first real upload end-to-end.
- RECOMMEND: upload one real WhatsApp finance-export zip on the live site; confirm
  it lands in the sandbox pile as DRAFT and appears in the Sandbox tab; do NOT
  feed-into-books until a fiscal period + the 8 real units are in.
- BASIS: unit tests pass but no real zip has been driven through the live UI.
- CONSEQUENCE IF NOT: "it's live" without proof the core loop works.
- BENEFIT: signed proof the upload→sandbox path works on real data.

## REC 5 — Delete the duplicate Vercel project "book-lets" (hyphenated).
- RECOMMEND: delete the hyphenated `book-lets` Vercel project; keep `booklets`.
- BASIS: two projects build every push; the hyphenated one is redundant and
  confusing. (CLI flag is `--yes`, not `--confirm`.)
- CONSEQUENCE IF NOT: double builds and ongoing "which URL is real" confusion.
- BENEFIT: one canonical production URL.

## MERGE ORDER (once REC 1–3 approved)
1. Merge #84 → main → Vercel deploys prod `booklets`.  [I execute; Raj does not touch GitHub.]
2. Verify REC 4 on the live site.
3. Schedule the dedup/RLS apply (REC 2/3) as a separate Hermes step.
4. Clean up Vercel duplicate (REC 5).

## WHAT I NEED FROM REVIEW
A PASS/FAIL on REC 1 (is merging #84 safe for a first go-live?) and REC 2 (is
going live without applying the RLS/dedup migrations correct?). Everything else
is sequencing.
