# QA Review — Receipt-Image → Ledger OCR Pipeline

**Scope:** the whole path a receipt photo takes to become a ledger draft, not
just the extracted total. Triggered by a real receipt-reading exercise where a
consolidated total came out wrong four different ways (double-counted subtotals,
a loyalty "you saved" line read as the bill total, dropped leading digits, and
tender/change read as the goods total).

**Method:** static read of every stage below, with `file:line` evidence. No
runtime execution (devserver/OCR/DB work is Hermes territory per the run spec).

**Status: v2 — revised after adversarial review.** Three independent
code-verifying reviewers attacked this review; their verdicts and the resulting
corrections are in `OCR-PIPELINE-REVIEW-VERDICTS.md`. The security lens returned
**FAIL**. Changes in v2: **F6 raised MED→HIGH** (schema defect → cross-tenant GL
contamination, not a query bug); **F4 corrected** (lines stamp **EUR**, and
currency is absent from the extraction schema entirely); **F5 reworded** (late
crash + orphaned master-data, not stored garbage); **F9/F10/F11 added**; the
reconciliation rules corrected for a self-contradiction (C.5 vs C.6) and a
loyalty-as-tender case.

**Pipeline under review**
1. Upload entry + guards — `src/app/actions/receipt.actions.ts`, `src/lib/upload-guard.ts`
2. Single receipt (WEB/MOBILE) — `src/lib/automation.service.ts`
3. Extraction client + fallback — `src/lib/gemini-ocr.ts`
4. Bulk (ZIP) ingest — `src/lib/zip-ingest.ts`
5. Staging → ledger bridge — `src/lib/ocr-bridge.ts`
6. Confidence / 4-eyes gate — `src/lib/approval.service.ts`

---

## What is already right (keep)

- **Always-DRAFT gate for automated entries.** `gateAutomatedJournalEntry` has
  no POSTED branch and the literal return type enforces it at compile time
  (`approval.service.ts:105-120`). No confidence — not even 1.0 — auto-posts.
- **4-eyes self-approval prevention**, role-independent, empty-identity-safe
  (`approval.service.ts:45-57`).
- **Upload guards** run before any OCR spend: O(1) size estimate without full
  decode, real magic-byte sniffing (JPEG/PNG/HEIC/WebP) (`upload-guard.ts`).
  *(The per-org rate limiter is here too but is per-process only — ineffective
  under serverless fan-out; see F11's note. Not counted as a real control.)*
- **ZIP path idempotency**: content `sha256` key, intra-archive dedup, DB unique
  backstop — a resend cannot double-create (`zip-ingest.ts:454-468`).
- **Money stays `Decimal`** end-to-end in the bridge; no float (`ocr-bridge.ts`).
- **Org resolved server-side**, never from client input (`receipt.actions.ts:37-40`).

---

## Findings (severity-ranked)

### F1 — HIGH — The single-upload path can double-book the same receipt
`AutomationService.processReceipt` creates an `Expense` + `JournalEntry` with
**no idempotency key and no content-hash dedup** (`automation.service.ts:155-205`).
The ZIP path guards exactly this (`zip-ingest.ts:458-468`); the WEB/MOBILE path
does not. A double-tap, a retry after a slow response, or a mobile re-submit
posts the same purchase twice — a literal double-count at the workflow level,
the same class of error the exercise was about, one layer up from the OCR.
**Fix:** compute `sha256` of the decoded image, pass
`idempotencyKey = computeEntryIdempotencyKey(org, sha256)` to `postEntry`, and
short-circuit if it already exists — mirror the ZIP path.

### F2 — HIGH — Two ingestion paths hold opposite date policies; one fabricates
The bridge parks a dateless row as `NO_DOC_DATE` and documents "dates are NEVER
fabricated" (`ocr-bridge.ts:19-23,141`). But the ZIP path calls
`ocrDateOrNow()`, which silently substitutes **today** when the receipt date is
missing or unparseable (`zip-ingest.ts:405-411,491`), and the single path does
`new Date(date)` on a possibly-empty string (`automation.service.ts:166,180`).
A missing receipt date therefore becomes the *ingest* date, booking the expense
into the wrong period — the exact date-confusion class the exercise hit
(14/07/2025 vs 2026). **Fix:** one policy everywhere — never fabricate; reject
(single path) or park (bulk) a dateless receipt.

### F3 — HIGH — No total reconciliation: the model's number is trusted wholesale
The extraction contract carries a single `totalAmount` plus a **self-reported**
`confidence` (`gemini-ocr.ts:21-27`). Nothing cross-checks that total against
line items, subtotal, or tender/change, so all four exercise failure modes pass
silently:
- summing subtotal **+** line items, or gross **+** net **+** cash paid (double count);
- reading a loyalty / "you saved" line as the total (the Rs. 2,142 error);
- a dropped leading digit (159 vs 1,159; 28 vs 328);
- reading "cash paid" / "balance" instead of the goods total.

`confidence` is only range-validated (`approval.service.ts:112-120`) and never
gates behaviour (always DRAFT), so a confidently-wrong figure reaches the 4-eyes
queue labelled "0.95" with **no mismatch signal**. This is the central lesson of
the exercise and it is currently unenforced. **Fix:** extend the extraction to
return `lineItems[]` and any printed `subTotal`/`grandTotal`, then reconcile
(see "Extraction rules to codify" below); on mismatch beyond tolerance, lower
confidence and flag for the checker — never silently pick the larger number.

### F4 — MEDIUM — Currency is not enforced on the direct/ZIP paths (and can't be)
The bridge parks non-LKR as `FX_UNSUPPORTED` (`ocr-bridge.ts:143`), but
`automation.service` and `zip-ingest` post `totalAmount` with no currency check
(`automation.service.ts:191-194`; `zip-ingest.ts:501-504`). **v2 correction:**
the lines don't pass a currency, so `JournalLine.currency` takes its schema
**default of "EUR"** (`prisma/schema.prisma:196`) — an LKR receipt is stamped
**EUR**, not "booked as LKR." And currency is **absent from `GeminiExtraction`
entirely** (`gemini-ocr.ts:21-27`), so non-LKR is *structurally undetectable* on
these paths (the bridge only parks FX because it reads a staging DB column). Fix
needs an extraction-schema field, not just a check.

### F5 — MEDIUM — Bad date crashes the direct-path post after partial writes
**v2 correction:** `validateExtraction` normalises the direct-path date to
`YYYY-MM-DD` or `""` (`gemini-ocr.ts:164-176`), so `new Date('')` → Invalid Date
**throws** in `postEntry` — it is *not* stored. The real harm is a **late crash
after orphaned `vendor`/`expenseCategory` rows** are created outside the
transaction (`automation.service.ts:110-142`), plus the SymbiOS fallback
(unvalidated, F7) which can turn an ambiguous string like `"03/04/2025"` into a
valid *wrong* date. Guard the date beside the amount check and validate every
extractor's output.

### F6 — HIGH — Global vendor/category tables → cross-tenant GL contamination
**v2 correction (raised MED→HIGH):** `ExpenseCategory` and `Vendor` have **no
`organizationId` column** (`prisma/schema.prisma:292-307`) — they are global,
resolved by unanchored `contains` (`automation.service.ts:110-112,130-132`).
Because a category's `accountId` points at an org-scoped `Account`, Org B's
receipt can reuse a category row Org A created → Org B's DRAFT line is built
against **Org A's GL account** (`automation.service.ts:144,192`): live
cross-tenant ledger contamination, one approval from POSTED. Worse, the
unvalidated SymbiOS fallback (`81-87`) can pass `vendorName: undefined`, making
`contains: undefined` a **no-op filter** that returns the first vendor in the
global table. This is a **schema defect**, not a query bug — "add an
`organizationId` filter" is unimplementable until `Vendor`/`ExpenseCategory` are
org-scoped by migration.

### F7 — LOW/MEDIUM — SymbiOS fallback bypasses extraction validation
The microservice path runs `validateExtraction` (normalises vendor/date/category,
clamps confidence) (`gemini-ocr.ts:88,157-200`); the SymbiOS fallback returns
`data as GeminiOcrResult` unvalidated (`gemini-ocr.ts:144-145`), and the inline
SymbiOS fallback in the service trusts fields raw (`automation.service.ts:81-87`).
Two extractors, one validated. Run every extraction through the same validator.

### F8 — LOW — Confidence is decorative
Because automated entries are always DRAFT, `confidence` never changes
behaviour: a genuinely unreliable scan is indistinguishable from a clean one in
the queue. Prefer surfacing a **reconciliation/mismatch** signal (F3) over a
self-reported score the checker can't calibrate.

### F9 — HIGH — ZIP path can POST a zero-amount entry, bypassing a ledger invariant *(added in v2)*
The ZIP path has **no positive-amount guard** (`zip-ingest.ts:501-504`), unlike
the single path (`automation.service.ts:102`) and the bridge (BAD_AMOUNT park).
A malformed OCR response defaults `totalAmount:0` (`gemini-ocr.ts:78-84`) → a
0.00 DRAFT is created. `LedgerService.postEntry` runs its "no zero-amount lines"
check only for POSTED (`ledger.service.ts:238-247`), and DRAFT→POSTED approval
flips status via a raw `updateMany` (`approval.actions.ts:248-251`) that re-runs
only trial-balance (0=0 passes) and fiscal period — **never re-applying the
zero-line check**. A rubber-stamped "trivial" 0.00 becomes a compliance-forbidden
POSTED entry.

### F10 — MEDIUM — ZIP path never calls `gateAutomatedJournalEntry` *(added in v2)*
`zip-ingest.ts:489-505` hardcodes DRAFT and forwards `agentConfidence` raw; the
single path and bridge gate confidence and throw on NaN/<0/>1. With the
unvalidated SymbiOS fallback (`gemini-ocr.ts:144-145`), an out-of-range/NaN
confidence reaches the ledger row with no loud failure. The path itself lacks a
gate backstop — broader than F7.

### F11 — LOW — Malformed JSON fabricates a confidence from the OCR envelope *(added in v2)*
On `JSON.parse` failure, `confidence: data.confidence || 0` (`gemini-ocr.ts:83`)
uses the microservice's **text-detection** confidence, not extraction
confidence — a garbage receipt (`totalAmount:0`) can still show the checker 0.9.

*Also flagged:* the per-org rate limiter is per-process, so on serverless every
cold lambda gets a fresh 10-token bucket (effective cap N×10/min,
`upload-guard.ts:14-18,173`) — it belongs with caveats, not in "what's right".
WhatsApp transcript text + participant names are persisted to the evidence log
(`zip-ingest.ts:527-542`) — PII retention worth a policy note.

---

## Extraction rules to codify (the exercise, generalised)

These belong in the extraction prompt/contract and in a pure reconciliation
guard the pipeline can run regardless of which extractor produced the numbers:

1. **Goods value = the gross subtotal of items received**, counted exactly
   **once** — *not* necessarily the "amount payable". When loyalty points /
   vouchers act as **tender** (`NET = SUBTOTAL − points`), the expense incurred
   is the gross subtotal; the redemption is a separate income/liability offset.
   Picking NET under-books the expense (the Rs. 2,142 error, inverted). *(v2 —
   corrects the earlier "one amount = GRAND/NET TOTAL" rule, per reviewer C-6.)*
2. **Never** sum line items on top of a printed total; **never** add
   SUBTOTAL + TOTAL, or GROSS + NET + CASH PAID (the same money restated).
3. **Reconcile structurally, not by a percentage band.** Check
   `Σlines − discounts + tax == total`, with tolerance only for per-line
   rounding (±0.5 × weighted-line-count). A blind % tolerance wide enough for
   50 weighted+VAT lines also passes a genuine double-count. *(v2, reviewer C-7.)*
4. A **loyalty / "you saved" / points** line is **not** the total, and when used
   as tender it must be **added back** to reconstruct goods value (rule 1).
5. Guard **dropped leading digits** — but the line-item sum is **not** a
   sufficient cross-check: a uniformly mis-OCR'd price column drops the same
   digit from the lines *and* the total, so they still agree. Cross-check the
   goods total against **`cash_paid − change`**, an independent right-aligned
   column. *(v2 — resolves the C.5/C.6 self-contradiction, reviewer C-5.)*
6. **"Cash paid" / "change" / "balance"** are tender, not the bill — but they
   are the **reconciliation anchor** of rule 5, so capture them; do not discard.
7. One physical slip = one receipt; multiple slips = multiple receipts (don't merge).
8. **Never fabricate dates** — park/reject when absent (align every path to the bridge).
9. **Enforce currency** — requires a `currency` field in the extraction schema
   first (F4); then park non-LKR on every path.
10. **Dedup by content hash** on every path (hard idempotency for mechanical
    retries), plus a **soft `(vendor, date, total±tol)` near-duplicate FLAG** to
    the 4-eyes queue for re-photographed/recompressed dupes — never an auto-drop.

> **Structural blocker (F3):** rules 1–6 need `lineItems[]`, `subTotal`,
> `grandTotal`, and tender fields that `GeminiExtraction` does not have today
> (`gemini-ocr.ts:21-27`). Extending the extraction schema is the prerequisite —
> the exercise's core lesson is currently *unrepresentable*, not merely unenforced.

---

## Suggested remediation order *(revised in v2)*
1. **Shared pre-post guard + close the approval bypass (F9, F10, F1, F2).** Route
   all three ingestion paths through one guard (positive amount, confidence gate,
   date policy, dedup) **and** re-run the zero-amount-line check inside the
   DRAFT→POSTED approve branch (`approval.actions.ts`) so approval enforces the
   same invariants as a direct `postEntry`. This closes the F9 `updateMany`
   bypass — the single most damaging path (a POSTED zero-amount entry violating a
   ledger compliance invariant).
2. **Org-scope `Vendor`/`ExpenseCategory` (F6).** Schema migration to add
   `organizationId`, then exact + org-scoped resolution. Blocks cross-tenant GL
   contamination — cannot be fixed at the query layer alone.
3. **Extend the extraction schema (F3, F4):** add `lineItems[]`, `subTotal`,
   `grandTotal`, tender, and `currency`, then implement the structural
   reconciliation guard (rules 1–6) and non-LKR parking.
4. **F5/F7/F8/F11** (date guard, validate every extractor, surface a
   reconciliation signal instead of a self-reported score) — hardening.

Each fix is behind the existing always-DRAFT + 4-eyes gate, **except F9**, where
approval can currently promote a zero-amount DRAFT past the ledger's own check —
so F9 is the one place the gate does not fully hold and should go first.
