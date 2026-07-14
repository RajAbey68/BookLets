# QA Review — Receipt-Image → Ledger OCR Pipeline

**Scope:** the whole path a receipt photo takes to become a ledger draft, not
just the extracted total. Triggered by a real receipt-reading exercise where a
consolidated total came out wrong four different ways (double-counted subtotals,
a loyalty "you saved" line read as the bill total, dropped leading digits, and
tender/change read as the goods total).

**Method:** static read of every stage below, with `file:line` evidence. No
runtime execution (devserver/OCR/DB work is Hermes territory per the run spec).

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
  decode, real magic-byte sniffing (JPEG/PNG/HEIC/WebP), per-org token-bucket
  rate limit (`upload-guard.ts`).
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

### F4 — MEDIUM — Currency is not enforced on the direct/ZIP paths
The bridge parks non-LKR as `FX_UNSUPPORTED` (`ocr-bridge.ts:143`), but
`automation.service` and `zip-ingest` post `totalAmount` with no currency check
and no currency on the ledger lines (`automation.service.ts:191-194`;
`zip-ingest.ts:501-504`). A GBP/USD receipt's raw number is booked as LKR. The
repo's own staging snapshot counts 11 non-LKR rows, so this is not theoretical.

### F5 — MEDIUM — Invalid/empty date can reach the ledger on the direct path
`automation.service` rejects a non-positive amount up front but not a bad date;
`new Date('')` → Invalid Date flows into `expense.create`/`postEntry`
(`automation.service.ts:102-107` guards amount only; `166,180-181` use the date).
It fails late (after partial work) or stores garbage. Guard it beside the amount
check.

### F6 — MEDIUM — Unanchored `contains` matching; vendor lookup not org-scoped
`vendor.findFirst({ where: { name: { contains: vendorName } } })`
(`automation.service.ts:110-112`) substring-matches the wrong master record for
short names **and carries no `organizationId` filter** — cross-tenant vendor
reuse. `expenseCategory … contains` (`130-132`) has the same substring hazard;
a miss auto-creates a category mapped to Suspense, quietly proliferating
categories. Match exact + org-scoped; resolve categories from a controlled set.

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

---

## Extraction rules to codify (the exercise, generalised)

These belong in the extraction prompt/contract and in a pure reconciliation
guard the pipeline can run regardless of which extractor produced the numbers:

1. **One amount per receipt** = the printed **GRAND / NET TOTAL** (amount
   payable), counted exactly **once**.
2. **Never** sum line items on top of a printed total; **never** add
   SUBTOTAL + TOTAL, or GROSS + NET + CASH PAID (the same money restated).
3. **Line items are a cross-check only.** Sum them, compare to the printed
   total; on mismatch beyond tolerance, lower confidence and flag — do **not**
   adopt the larger figure.
4. A **loyalty / "you saved" / points** line is **not** the total.
5. Guard **dropped leading digits** by comparing magnitude to the line-item sum.
6. **"Cash paid" / "change" / "balance"** are tender, not the bill.
7. One physical slip = one receipt; multiple slips = multiple receipts (don't merge).
8. **Never fabricate dates** — park/reject when absent (align every path to the bridge).
9. **Enforce currency** — park non-LKR on every path.
10. **Dedup by content hash** on every path, not just ZIP.

---

## Suggested remediation order
1. F1 + F2 (double-book, date fabrication) — correctness of what lands in the ledger.
2. F3 (reconciliation guard + extended extraction schema) — the exercise's core lesson.
3. F4/F5 (currency + date guards on the direct path) — parity with the bridge.
4. F6/F7/F8 (matching, validation parity, confidence signal) — hardening.

Each fix is behind the existing always-DRAFT + 4-eyes gate, so none can post to
the ledger unreviewed — they change what the checker *sees*, and stop silent
duplicates/mis-dates before they reach the queue.
