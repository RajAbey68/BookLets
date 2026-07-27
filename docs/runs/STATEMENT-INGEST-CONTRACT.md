# Statement Ingest Contract — bank-statement CSV → DRAFT journal entries

Modules: `src/lib/statement-ingest.ts` (pure core), `src/lib/statement-ingest.deps.ts`
(prisma wiring), `src/app/api/ingest/statement/route.ts` (POST /api/ingest/statement).
Tests: `tests/unit/statement-ingest.test.ts`, `tests/unit/statement-ingest-route.test.ts`.

## §1 Problem

Bank statements had NO line-level dedup. Re-uploading a statement — or uploading
two exports whose date ranges overlap — double-counted every shared transaction
**silently**. This is the exact failure mode that produced the Ko Lake sandbox
duplicates (payments imported multiple times across batches). This importer makes
per-transaction idempotency a property of the write path, not of operator care.

## §2 Key construction

- **Natural key** (per row): the bank's own transaction ID when the export has an
  ID column and the cell is non-empty (Wise `TransferWise ID` / `ID`, generic
  `Transaction ID` / `Reference`). Otherwise:

  `sha256( dateIso | amount | currency | normalizedDescription | runningBalance )`

  with `normalizedDescription` = trim, collapse internal whitespace, lowercase;
  `dateIso` = canonical `yyyy-mm-dd`; `amount` = canonical `Decimal.toString()`.
  The running balance disambiguates genuinely repeated transactions in ID-less
  exports (same day, amount and description).

- **Idempotency key** (what is persisted):

  `sha256( "stmt-ingest" ‖ NUL ‖ organizationId ‖ NUL ‖ naturalKey )`

  Same construction style as zip-ingest's `computeEntryIdempotencyKey`: domain
  prefix + NUL delimiters, so keys can never collide across ingest sources or
  organizations. Written to `JournalEntry.idempotencyKey`; `sourceId` carries the
  natural key and `source` = `STATEMENT_INGEST`.

## §3 Dedup layers

1. **In-file collapse** — duplicate keys within one upload create one candidate;
   the extras count as `deduped`.
2. **Ledger pre-check** — `findExistingIdempotencyKeys(org, keys)` filters out
   rows already ingested by ANY earlier upload; also counted in `deduped`.
3. **DB unique constraint** — the **EXISTING** `JournalEntry`
   `(organizationId, idempotencyKey)` unique index backstops concurrent races.
   A race loser surfaces in `failures[]`, never as a second entry.

**No migration is required or permitted for this feature** — enforcement rides
the unique index that is already applied in production (HR-5 baseline). Nothing
here touches `prisma/schema.prisma`.

## §4 Skip / failure reasons

Every data row lands in exactly one bucket; the report reconciles
`created + deduped + |skipped| + |failures| = totalRows`.

| Bucket | Reason | Meaning |
| --- | --- | --- |
| skipped | `ZERO_AMOUNT` | Zero-value row (notification/quote) — books nothing. |
| skipped | `FX_UNSUPPORTED` | Non-LKR currency. LKR-only books (ocr-bridge policy); no FX until S8. A missing Currency column is taken as LKR. |
| skipped | `NO_FISCAL_PERIOD` | No OPEN FiscalPeriod covers the row date. Dates are NEVER clamped or fabricated — the row waits for a human to open a period. |
| failures | unparseable date/amount | Reported per row; never aborts the rest of the file. |
| failures | postEntry error | Includes unique-constraint race losers (layer 3). |

## §5 DRAFT-only rule

Every entry is born `DRAFT` with `makerIdentity = AUTOMATION_MAKER_IDENTITY`.
There is no parameter, flag or confidence score through which a caller can force
`POSTED` — only the four-eyes approval flow promotes. Statements carry no
category, so both directions book against Suspense (9999): outflow = debit
Suspense / credit Bank (1000), inflow = debit Bank / credit Suspense, always at
the absolute amount (decimal.js end-to-end — money never touches `Number`). A
human recategorizes the Suspense leg during draft review.

## §6 Guards and route mapping

Core guards: 5 MB byte cap (`FILE_TOO_LARGE` → 413), 10,000 data rows
(`TOO_MANY_ROWS` → 422), parseable CSV (`INVALID_CSV` → 400), header with at
least Date/Amount/Description (`MISSING_COLUMNS` → 422). Route: 401 unauthenticated,
403 below OWNER/ADMIN, declared-length pre-check plus a byte-capped body stream
(spoofed Content-Length cannot buffer past the cap). One evidence-log event per
upload records the file sha256 and the full run counts.
