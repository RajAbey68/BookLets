# EXTERNAL ADVERSARIAL REVIEW PACKET — BookLets go-live prep
# For: Gemini 3.5 Pro AND GLM 5.2 (run each brief through both; paste verdicts back)
# Generated 2026-07-14 by claude-opus (Fable). Self-contained — no prior context needed.

## YOUR ROLE
You are an independent adversarial reviewer with NO prior context and NO access
to the live database. An Anthropic model made the changes below and has already
tried to refute its own work against the live schema. Your job: try to REFUTE
what remains. Be hostile to hand-waving. A PASS is a signed gate — give it only
if you cannot break the claim. Where you lack evidence to decide, say
INSUFFICIENT-EVIDENCE and name the exact query/file you would need.

## CONTEXT (facts, verified against the live Supabase DB unless marked ASSUMED)
- App: Next.js 16 / Prisma 7 / Supabase (Postgres 17) / Vercel. Double-entry
  bookkeeping for short-let properties (Ko Lake, Sri Lanka; books in LKR).
- Branch under review: `claude/prompt-looping-setup-tvqczj`, PR #71 (draft).
- App tables live in Postgres `public` schema. `prisma.ts` sets
  `search_path=booklets,public`; the `booklets` schema does NOT exist, so it
  falls through to `public`. Login/reads work. (VERIFIED)
- Prod migration baseline = `20260703_*`. The migrations `20260712_rls_org_isolation`
  and `20260713_sandbox_dedup_blocker` exist on this branch only and are NOT
  applied to prod. (VERIFIED via _prisma_migrations)
- Properties table is intentionally EMPTY (Raj's decision; 8 real Ko Lake units
  land later). Empty dashboard + hidden receipt uploader is EXPECTED, not a bug.

## CLAIM SET A — "The sandbox triple-count does not exist in live data"
The prior working theory (held by Raj and by the Anthropic model) was:
"sandbox.payment_entries holds 128 Ko Lake payments imported 3+ times across
batches b101216d/dedb5fda/8d3b8040; promoting them would triple-count LKR ~11.25M."

The Anthropic model then queried the live table and claims to REFUTE this:
- `sandbox.payment_entries` has exactly **128 rows**. (VERIFIED)
- Duplicates by content hash md5(source_type|source_ref|payment_date|amount|description):
  **0**. (VERIFIED)
- Duplicates by loose real-world key (payment_date|amount|description only,
  ignoring source_ref): **0**. (VERIFIED)
- `distinct_source_refs` = 128 (every row unique). `batch_id` is NULL on all 128
  rows (rows never linked to the 8 rows in `import_batches`). All 128 rows have
  status `unreviewed`. (VERIFIED)
- Gross of all 128 rows = **LKR 11,686,772.16** — asserted to be a TRUE
  single-count, not inflated by duplication.

ATTACK VECTORS (try to break the "no duplication" conclusion):
1. Is md5-of-those-5-columns a sound dedup key, or could genuine duplicates
   differ in ALL five fields yet be the same real payment? What field(s) would
   a re-import realistically change? (bank_ref is empty-string on these rows.)
2. Could duplication live UPSTREAM (raj_fin_track.ocr_receipts, 468 rows) or
   DOWNSTREAM once promoted, even though sandbox itself is clean now? The OCR
   bridge imports ocr_receipts (NOT sandbox) with a source_file-based
   idempotency key — is source_file a sufficient natural key, or can the same
   receipt arrive under two filenames and double-post?
3. `import_batches` has 8 completed batches but payment rows have NULL batch_id.
   Does that break provenance/auditability even though it doesn't cause double
   counting? Is "8 completed batches, 128 unlinked rows" itself a red flag?
4. Is "the number isn't inflated by duplication" the same as "the number is
   correct"? What else could make LKR 11.69M wrong (44% of rows are category
   'other'; income side is entirely absent from this table)?

## CLAIM SET B — "The dedup blocker migration was DOA and is now corrected"
The Anthropic model's FIRST version of `20260713_sandbox_dedup_blocker` assumed
columns that do not exist. Verified-against-live corrections it now claims:
- `sandbox.payment_entries` has NO `organization_id` and NO `deleted_at` column;
  its `id` is UUID (not BIGINT). `public."JournalLine"` must be quoted. The
  first draft used all four wrong assumptions → would fail on apply.
- The rewrite (see DIFF) is ADDITIVE ONLY: adds a STORED generated `content_hash`
  column (immutable ::text casts + md5), a non-unique index, and a
  `sandbox.find_payment_duplicates()` diagnostic function. It deliberately does
  NOT add a UNIQUE constraint, because (claim) a UNIQUE index cannot be created
  while duplicates exist — and enforcing uniqueness is a separate human-gated
  step documented in the migration's NEXT STEPS.
- The misplaced 409 guard was REMOVED from `POST /api/ingest/ocr-bridge`
  (it called a wrong-signature function against the wrong table and would 500).

ATTACK VECTORS:
1. Is the STORED generated column expression provably IMMUTABLE in Postgres 17?
   `payment_date::text` for a `date` — immutable? `amount::text` for `numeric` —
   immutable? md5(text) — immutable? If any is only STABLE, the migration fails
   with "generation expression is not immutable." Name the offender if so.
2. `CREATE INDEX IF NOT EXISTS` inside a Prisma migration runs in a transaction;
   `CREATE INDEX CONCURRENTLY` (used in the NEXT STEPS) cannot run in a txn. Is
   the migration internally consistent about which index type runs where?
3. Adding a STORED generated column rewrites the whole table and takes an ACCESS
   EXCLUSIVE lock. On 128 rows it's trivial — but is that pattern safe as a
   template if the table grows to millions? Flag if this is a latent footgun.
4. The migration leaves the table WITHOUT enforced uniqueness (only a diagnostic
   function). Does that actually satisfy Raj's requirement "even the sandbox
   should not have double counting no matter how many times we upload"? Argue
   whether additive-diagnostic-now / enforce-later is acceptable or a cop-out.

## CLAIM SET C — untouched areas you may also probe (lower priority)
- RLS migration `20260712_rls_org_isolation` (not applied to prod): txn-local
  `set_config('app.current_org_id', ..., TRUE)` GUC pattern for pgBouncer
  transaction-mode pooling. FORCE RLS is deliberately deferred (app connects as
  table owner; blind FORCE would blank prod). Attack: does the extension fail
  OPEN anywhere? See src/lib/prisma.ts resolveRlsWrapMode.
- Build fixes on this branch: added `adm-zip`; changed `TransformStream<...>`
  generic to untyped with typed callback params (CodeQL "superfluous arguments");
  deleted legacy root `middleware.ts` in favour of `src/proxy.ts`. Attack: any
  regression in auth gating or upload byte-cap behaviour from these?

## VERDICT FORMAT (return this, once per claim set)
```
checkerIdentity: <model name + version>
claimSet: A | B | C
verdict: PASS | FAIL | INSUFFICIENT-EVIDENCE
mostSeriousFinding: <one sentence, or "none">
evidenceNeeded: <exact query/file, or "none">
reasoning: <=6 sentences, attack-first
```
