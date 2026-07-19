# BookLets Ecosystem — Canonical Architecture (v1.0, 2026-07-14)

**Status:** Owner-decided; twice adversarially reviewed and FINAL-GATE APPROVED by Grok 4.5 (`gen-1784043290-bnIe1n3iSOV91Q4sJil0`, clean) and GLM 5.2 (`gen-1784043282-u8TH9wmRBnIcVBthBmEK`, approved with 4 hardening clauses — incorporated below, marked ⬢).
**Scope:** BookLets (double-entry books), the shared ingestion capability, ocr-microservice, and every future consumer (WhatsApp task app, etc.).
**Rule zero:** No agent or developer may assert "feature X is missing" or build against this ecosystem without reading this document first.

> **This file is the target DESIGN.** For what is actually deployed, wired, and
> configured right now — live service endpoints, env config, current gaps
> (incl. the OCR/DevServer wiring) — see the companion
> [`RUNTIME-SERVICE-MAP.md`](./RUNTIME-SERVICE-MAP.md). Known design-vs-as-built
> drift is tracked there in §8.

---

## 1. Services & ownership

| Component | Form | Owns | Never does |
|---|---|---|---|
| **BookLets** (Next.js + Prisma + Supabase) | Product app | ALL financial staging, promotion, journal writes; the sandbox UI; 4-eyes approval | Delegates ledger writes to anyone |
| **ingest library** (successor to `file-upload-server` service) | **Shared LIBRARY, not a hot service** | Zip/decompose, format handling, OCR-client orchestration, typed DTO assembly — as code | Runs as a shared runtime on the money path; holds any consumer DB credentials |
| **ocr-microservice** | Stateless extract-and-hand-back service | Decompose + OCR + auxiliary extraction | Writing to ANY application database; deciding posting status |
| **WhatsApp/task app & others** | Product apps | Their own data via their own copy of the ingest library | Writing the BookLets ledger — if they need books action, they call the BookLets API as an authenticated org |

## 2. The ingest library — one-version (lockstep) rule
- ONE repo, one release pipeline, immutable versioned artifacts (private npm package).
- Every consumer pins the EXACT current release (no `^`/`~`), lockfiles committed. Copies are dead artifacts — never edited locally.
- **Lockstep enforced in CI:** a consumer pinned behind the current release fails its build. Fix once upstream → release → automated bump PRs (Renovate/Dependabot) → all apps redeploy green.
- Consequence accepted by owner: every library release obligates redeploying all consumers; breaking changes are blocked until all consumers can take them (forces backward-compatible design).
- Shared *infrastructure* (object storage, signed upload URLs, virus-scan utility) may be common; shared *money-path semantics* may not.

## 3. Hand-back contract (uploader/OCR → consumer)
- Typed, VERSIONED DTO only (`/contracts/booklets.ingest.vN.json`): amounts as decimal strings (floats banned end-to-end), ISO currency codes, ISO dates, document-type enum, extraction version, per-line-item arrays with line hashes, source-file SHA-256, orgId, **ingestionId** (unique per hand-off), confidence as metadata, explicit nullability.
- Transport: consumer pulls (signed URL/poll) or receives an HMAC-signed, timestamped, idempotent webhook. Dead-letter + poison-message policy documented. At-least-once delivery assumed.
- OCR/uploader components hold ZERO database credentials for any consumer, ever.
- ⬢ **NUMERIC binding:** decimal strings must bind to Postgres `NUMERIC` with no intermediate JS `Number` coercion anywhere in the path (Prisma `Decimal` end-to-end); a CI test asserts precision survival on large/exact values.

## 4. Staging (the sandbox)
- Lives in the BookLets DATABASE as a SEPARATE SCHEMA (`booklets_staging`) alongside the ledger schema (`booklets`).
- **Everything lands in staging. Nothing auto-POSTs. OCR confidence is queue-priority metadata only.** The confidence>0.9 auto-POST path is abolished; a regression test hard-fails if it reappears.
- UX principle: OCR-assisted manual entry — a native entry form pre-filled with OCR suggestions; a failed OCR still allows sub-10-second manual entry.
- NO foreign keys in either direction between staging and ledger schemas. Lineage = immutable promotion audit record (source ids as values + hashes).
- Staging rows become immutable (status `PROMOTED`, or archived) after promotion.

## 5. Promotion (staging → books)
- Single atomic path: a row-locked, fully revalidating transaction (Postgres function `promote_staging_to_ledger(staging_id, approver_id)` called via the LedgerService choke point — DB-side locking per GLM; single-transaction invariants per Grok).
- Revalidates at promote time: amount > 0, currency consistency, tenancy, fiscal-period gate, debits == credits.
- **4-eyes at the database:** preparer ≠ approver enforced by constraint/trigger, not just app code. ⬢ The promote function must verify at execution time that `approver_id` is a *distinct, currently-authorized approver* (session-derived identity, membership/role checked inside the function) — structural inequality of two ids is not sufficient.
- **Idempotent:** UNIQUE promote keys on (orgId, stagingRowId/promotionId). Source-file hash is a duplicate *signal* (warn/flag), never the sole suppression key. Double-click/double-webhook/retry can never double-post.

## 6. Single-writer enforcement (defense in depth)
1. DB roles: `staging_writer` cannot touch ledger tables; only the `ledger_writer` path can INSERT journal rows; PUBLIC revoked; explicit grants only.
2. FORCE ROW LEVEL SECURITY on every sensitive table in BOTH schemas, policies keyed on orgId. No RLS-bypassing service role on request paths (Supabase service key confined to migrations/admin). ⬢ `FORCE` is explicitly required on **staging** tables too: Postgres table owners bypass RLS unless FORCE is set, and `staging_writer` must never hold owner-equivalent grants on staging tables.
3. Secrets isolation: OCR/uploader/other products never receive the BookLets DATABASE_URL; no shared Vercel env groups containing ledger credentials.
4. Application choke point: only LedgerService imports journal models (lint/dependency-cruiser boundary enforced in CI).
5. Standard of proof: a NEGATIVE integration test — non-ledger-writer identities attempting journal INSERT must be DENIED — runs in CI.

## 7. Schema/tenancy corrections (accepted defects to fix)
- Add `organizationId` to `Vendor` and `ExpenseCategory`; org-scope all lookups; unique vendor name per org.
- Append-only triggers on ledger tables (`BEFORE UPDATE/DELETE` raise unless maintainer role).
- Remove the fabricated `yieldBand` display; real metrics only (P1 zero-fabrication).
- `prisma db push` BANNED on any prod path; SQL-first migrations via `prisma migrate deploy`; CI asserts `pg_policies`/grants/triggers exist AFTER running real migrations against a throwaway Postgres.
- Qualify schema names everywhere; never rely on default `search_path`. ⬢ **Resolved policy (not merely an audit item):** session-state-dependent RLS patterns (`SET ROLE`, session-scoped `SET`) are BANNED under PgBouncer transaction-mode pooling — RLS context must be carried per-transaction (transaction-scoped settings inside the same transaction as the query, or Supabase JWT→RLS), and a CI check greps/asserts no banned pattern ships. Session reuse after `SET ROLE` = cross-tenant walk.

## 8. Compliance (OCR egress)
- DPA/data-residency check for the Gemini path; PII minimization before egress (redact account numbers/national IDs where possible); allowlist of fields sent; no raw PII in logs/traces; TTL purge of temp artifacts; disclosure in ToS.

## 9. Test harness gates (deploy-blocking)
- Consumer-driven contract tests (library↔consumer, OCR↔library) pinned to the DTO version.
- Ingestion-format matrix owned by the library repo (start: top-5 real formats + empty/oversized/polyglot/zip-bomb/wrong-MIME).
- Staging isolation: unpromoted rows never appear in reports (tested with the real reporting role).
- Negative capability tests (per §6.5); promote-retry/concurrency test (exactly one POSTED + one audit row); partial-batch poison isolation; real-migration deploy-path test; RLS/grant assertions in CI; log-redaction assertion.
- Existing 247 mocked unit tests retained for pure logic only — they do not count as integrity proof.

## 10. First three implementation steps (ordered)
1. **Kill auto-POST** — all outcomes land in staging; delete confidence→POST; regression test forbidding it; preparer ≠ approver at DB.
2. **Lock the write perimeter** — roles/grants + FORCE RLS on both schemas; revoke all non-BookLets DB access; negative integration tests.
3. **Idempotent promote + contract v1** — versioned ingest DTO + ingestionId; UNIQUE promote keys; retry/double-webhook E2E on real Postgres with real migrations.

---
*Provenance: owner decisions (2026-07-14) refined per adversarial reviews — Grok 4.5 (gen-1783969063…, gen-1784042241…, gen-1784042343…), GLM 5.2 (gen-1783969075…, gen-1784042239…). Full verbatim verdicts in session log / RAJ-674.*
