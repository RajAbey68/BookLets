# S1b — Staging→Ledger Bridge Contract (`raj_fin_track.ocr_receipts` → `public.JournalEntry`)

**Status:** OPEN — design locked (this doc), build not started.
**Owner:** Fable builder wave (next). **Decision authority:** this closes the
"raj_fin_track ↔ public split" design decision flagged in the 2026-07-12 audit
(bus: "INCOHERENT PIPELINE"). Verified independently by Hermes (Layer-2, live
ssh/SQL) and Fable (read-only connector) on 2026-07-12.

## 1. Why this exists
S1 loaded OCR'd receipts into the staging schema `raj_fin_track` (the spec's
stated S1 target). The BookLets app reads only `public` Prisma tables; no code
references `raj_fin_track` anywhere in `src/`. Without a bridge, S6 (review UI),
S9 (reconciliation), and every report operate on 10 seed rows forever. S1 is
therefore re-baselined as **PARTIAL: ingest done, ledger-visible = no**.

## 2. Verified source state (read-only snapshot, 2026-07-12 ~20:00 UTC)
`raj_fin_track.ocr_receipts` — 468 rows, columns:
`id int PK, source_file text NOT NULL (unique in practice, 1 file = 1 row),
document_type, doc_date date, vendor_or_entity, total_amount numeric(19,4),
currency, is_labour_payment bool, category, description, line_items jsonb,
raw_response jsonb, ocr_engine, ocr_status, error_message, processed_at, created_at`.

Eligibility buckets (drift expected as the weekly cron re-runs; importer must
compute at run time, never hardcode):

| Bucket | Count | Disposition |
|---|---|---|
| `ocr_status='success'`, `total_amount>0`, `doc_date` present, `currency='LKR'` | **179** | **POST as DRAFT** |
| success, amount>0, dated, non-LKR (GBP/USD/"other") | 11 | PARK `FX_UNSUPPORTED` — LKR books; no FX rate policy until S8 (Wise) lands |
| success, amount>0, `doc_date IS NULL` | 111 | PARK `NO_DOC_DATE` — do **not** fabricate dates from `processed_at`; HIL assigns |
| success, amount NULL/≤0 | 29 | PARK `BAD_AMOUNT` — zero-amount guard would (rightly) reject |
| `ocr_status<>'success'` | 138 | PARK `OCR_FAILED` — re-OCR is devserver work (E6), not the bridge's job |

## 3. Transport decision (locked): in-app importer, same database
**Option A — chosen.** A server-side importer service + admin-triggered API
route inside BookLets. Staging and ledger live in the SAME Postgres instance,
so the bridge is a cross-schema read via `prisma.$queryRaw` (schema-qualified
`raj_fin_track.ocr_receipts` — the table is NOT added to schema.prisma; it is
foreign territory, read-only), then normal `LedgerService.postEntry` writes.

Rejected: (B) devserver-side script POSTing to an ingest API — re-introduces
Vercel body limits (S5's known problem), splits idempotency across two systems,
and adds a network hop for data already co-located.

Batched (default 50/invocation) to fit serverless time budget; idempotent, so
the route is re-invoked until it reports `remaining: 0`.

## 4. Mapping (per eligible row)
| Source | Target |
|---|---|
| `source_file` | `JournalEntry.idempotencyKey = 'ocr-receipt:' + source_file` (org-scoped unique — replay-safe) |
| `doc_date` | `JournalEntry.date` |
| `vendor_or_entity` | Vendor resolve-or-create; memo `AUTOMATED S1b: Receipt <source_file> — <vendor>` |
| `category` | ExpenseCategory resolve-or-create → mapped GL account, else Suspense (9999) |
| `total_amount` | debit expense account / credit bank (code 1000, fallback Suspense) — `numeric(19,4)` end-to-end, no float |
| `currency` | `JournalLine.currency` (always 'LKR' for eligible rows) |
| — | `status`: **always DRAFT** via `gateAutomatedJournalEntry` (no POSTED branch at type level); `source='OCR_RECEIPT'`, `sourceId=String(id)`, `agentConfidence` from raw_response if present else null; `makerIdentity='booklets-automation-service'` (E5 session-identity mandate still open — logged, not silently dropped) |

Parked rows are returned in the route's response summary as
`{reason, count, ids[]}` — never written back to `raj_fin_track` (source is
read-only to the app) and never invented into the ledger.

## 5. Hard prerequisites (ordered)
1. **HR-5** — `MIGRATION-BASELINE-DDL.sql` applied + migrate-resolve baseline.
   The bridge writes `idempotencyKey`/`source`/`sourceId`, which do not exist
   in prod until HR-5 lands. Building S1b first = more dead code.
2. **HR-6 (new, for Hermes)** — verify/grant app-role read access:
   `GRANT USAGE ON SCHEMA raj_fin_track TO <app_role>; GRANT SELECT ON raj_fin_track.ocr_receipts TO <app_role>;`
   (If the app connects as the table owner this is a no-op — verify, don't assume.)
3. Org + seed accounts (9999, 1000) present for the target organization —
   verified live: 1 org, seeded.

## 6. Acceptance evidence (🛑 checkpoint, four-eyes)
- `SELECT count(*) FROM public."JournalEntry" WHERE source='OCR_RECEIPT'` = eligible-bucket count at run time (~179), all `status='DRAFT'`.
- Re-invoke the route: 0 new entries (idempotency proof, verbatim output).
- 3 spot checks: staging row ↔ JournalEntry+lines (amount, date, vendor) side by side.
- Parked summary totals + eligible total = staging row count (nothing silently dropped).
- Trial balance unchanged by DRAFTs (DRAFT excluded from TB until POSTED) — assert, don't assume.
- Layer-2 (HermesBot/Hermes) re-runs the count queries independently before PASS.

## 7. Non-goals
No writes to `raj_fin_track`; no POSTED entries; no FX conversion; no OCR/re-OCR;
no date fabrication; no Hostaway coupling. Go-live/promote-to-POSTED remains a
Raj-only action at Z.
