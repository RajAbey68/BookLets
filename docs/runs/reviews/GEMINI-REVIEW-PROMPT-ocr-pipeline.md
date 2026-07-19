# Gemini Adversarial Review — Receipt OCR → Ledger Pipeline (paste-ready)

> **How to use:** paste everything below the line into Gemini (AI Studio or the
> Gemini app). It is fully self-contained — Gemini needs no repo access. Paste
> the returned verdict block back here and it will be folded into
> `OCR-PIPELINE-REVIEW-VERDICTS.md`.

---

You are an **independent, adversarial code reviewer**. You have **no access to
the repository or database** — everything you need is in this prompt. Your job
is to find where this receipt-processing pipeline books **wrong, duplicate, or
mis-dated money into an accounting ledger**, to challenge the severity ratings,
and to break the proposed reconciliation rules. Be blunt. Where you cannot break
a claim, say so and sign it.

## System context
- **BookLets** is a multi-tenant (per-organisation) accounting app that books in
  **LKR**. Users upload receipt photos; an OCR service extracts a total; the app
  creates a **DRAFT** journal entry. DRAFT→POSTED happens only via human 4-eyes
  sign-off. No confidence score (even 1.0) auto-posts — enforced at compile time
  by a gate with no POSTED branch. **This gate is sound; do not spend effort
  attacking it — attack what reaches the human queue and what the schema allows.**
- Three ingestion paths reach the same ledger: (a) **single upload** (web/mobile),
  (b) **ZIP bulk ingest** (WhatsApp exports), (c) a **staging→ledger bridge** over
  pre-OCR'd rows.
- The OCR extraction returns a flat object per receipt:
  `{ vendorName, date (ISO or ""), totalAmount: number, categorySuggestion,
  confidence: 0..1 }`. **There is no line-item, subtotal, tender, or currency
  field.** A shared microservice produces it; a second service (SymbiOS) is a
  fallback that is **not** run through the same validation.

## Why this review exists
A real receipt-consolidation exercise produced a total that was wrong four
independent ways: (a) a subtotal **and** its line items were both summed; (b) a
loyalty "you saved Rs. 2,142" line was read as the bill total (true total was
~Rs. 12,458); (c) leading digits were dropped (159 vs 1,159; 28 vs 328); (d)
"cash paid"/"balance" was read as the goods total.

## Findings to adjudicate (confirm / refute / re-rank)
Severities are the current internal ratings. Challenge them.

- **F1 (HIGH)** — the single-upload path passes no idempotency key, so the same
  receipt uploaded twice creates two expenses + two DRAFT entries (double-book).
  The ZIP path dedups by image SHA-256; the single path does not.
- **F2 (HIGH)** — date policy diverges: the bridge PARKS a dateless receipt and
  never fabricates; the ZIP path substitutes **today** when the date is missing/
  unparseable; the single path passes `new Date("")`.
- **F3 (HIGH)** — no total reconciliation. Only a single `totalAmount` and a
  self-reported `confidence` are captured; nothing cross-checks line items /
  subtotal / tender. All four exercise failure modes pass silently. Note: the
  extraction schema has **no fields** to represent line items/subtotal/tender, so
  the fix is a schema extension, not just logic.
- **F4 (MED)** — currency is not enforced on the single/ZIP paths, and the ledger
  line's currency column **defaults to "EUR"** — so an LKR receipt is stamped EUR.
  Currency is absent from the extraction schema, so non-LKR is undetectable there.
- **F5 (MED)** — a bad date crashes the single-path post *after* creating
  vendor/category rows outside the transaction (orphaned master data).
- **F6 (HIGH)** — the `Vendor` and `ExpenseCategory` tables have **no
  `organizationId` column** (they are global), and are resolved by unanchored
  `contains`. A category's `accountId` points at an org-scoped `Account`, so
  Org B's receipt can reuse a category row Org A created and book Org B's DRAFT
  line against **Org A's GL account** — cross-tenant contamination, one approval
  from POSTED. Fix requires a schema migration, not a query change.
  Relevant schema (verbatim):
  ```prisma
  model ExpenseCategory { id String @id; name String; accountId String?; expenses Expense[] }
  model Vendor          { id String @id; name String; expenses Expense[] }
  ```
- **F7 (MED)** — the SymbiOS fallback extraction skips the validation/clamping the
  primary path runs; an unvalidated `vendorName: undefined` turns a `contains`
  filter into a no-op that returns an arbitrary global vendor.
- **F8 (LOW)** — `confidence` never changes behaviour (always DRAFT), so an
  unreliable scan is indistinguishable from a clean one in the queue.
- **F9 (HIGH) — ALREADY FIXED; review the fix.** The ledger's "no zero-amount
  lines" check ran only when creating a POSTED entry. DRAFT→POSTED approval
  re-ran trial-balance + fiscal-period but **not** the zero-line check, and a
  zero-amount draft balances (0=0), so it could be approved past the invariant.
  The fix: extracted the check into a shared `assertNoZeroAmountLines(lines)`
  called from BOTH `postEntry` (POSTED branch) and the approval APPROVE branch,
  plus a positive-amount guard on the ZIP path before creating the draft.
  **Question for you: is this fix complete, or is there another path
  (reversal, direct SQL, a different writer) that still promotes a zero/negative
  entry?**
- **F10 (MED)** — the ZIP path never calls the confidence gate (`gateAutomated…`),
  so an out-of-range/NaN confidence from the unvalidated fallback reaches the row.
- **F11 (LOW)** — on malformed OCR JSON, the code sets confidence to the
  microservice's *text-detection* confidence, so a garbage receipt (total 0) can
  still show the checker 0.9.

## Proposed reconciliation rules (attack these)
1. Goods value = the **gross subtotal of items received**, counted once — not
   necessarily "amount payable" (loyalty points used as tender make NET < goods).
2. Never sum line items on top of a printed total; never add SUBTOTAL+TOTAL or
   GROSS+NET+CASH.
3. Reconcile structurally (`Σlines − discounts + tax == total`), tolerance only
   for per-line rounding — not a blind percentage.
4. A loyalty / "you saved" / points line is not the total; if used as tender it
   must be added back to reconstruct goods value.
5. Guard dropped leading digits by cross-checking the goods total against
   `cash_paid − change` (an independent right-aligned column) — NOT against the
   line-item sum (a uniformly mis-OCR'd price column drops the same digit from
   lines and total together, so they still agree).
6. Capture "cash paid"/"change" as the reconciliation anchor; do not discard them.

## Attack specifically
1. Reconciliation tolerance: give a rule that survives 50 weighted (weight×price)
   lines + per-item VAT + a coupon, yet still catches a genuine double-count of a
   small item. Can a single scalar tolerance ever do both?
2. Which printed figure is authoritative when a receipt shows SUBTOTAL, DISCOUNT,
   GRAND TOTAL, CASH, CHANGE and two are equal by coincidence? Construct a layout
   where rule 1 books the wrong number.
3. Loyalty-line detection: keyword, position, or arithmetic non-participation?
   Show a layout (e.g. a non-English "you saved") that defeats your choice.
4. Digit-drop: if line items are themselves mis-OCR'd, does rule 5's tender
   cross-check still catch it, or can you launder a consistent-but-wrong total?
5. Idempotency (F1): is image SHA-256 the right dedup key? What legitimately
   changes the hash for the same purchase (re-photo, crop, EXIF-strip, WhatsApp
   recompression)? Is `(vendor, date, total)` better, and what does IT break?
6. F6: beyond adding `organizationId`, how should the backfill assign existing
   global vendor/category rows to organisations without mis-assigning shared
   vendors? What is the safest failure mode?
7. F9 fix completeness (see above).
8. Reconciliation gate: should a failed reconciliation BLOCK draft creation or
   create the draft with a loud flag? Argue the accounting-safe default.
9. What is the single most damaging thing this pipeline could do to a production
   ledger, and the one change that most reduces it?

## Return exactly this verdict block
```
REVIEWER: Gemini <version>
VERDICT: PASS | PASS-WITH-CONDITIONS | FAIL
BLOCKING FINDINGS: <numbered; each a concrete failure scenario or receipt layout>
NON-BLOCKING FINDINGS: <numbered>
DISPUTED SEVERITIES: <which of F1–F11 you would raise/lower, and why>
MISSED FINDINGS (not in F1–F11): <numbered>
F9 FIX VERDICT: <complete / incomplete — why>
ANSWERS 1–9: <one line each>
SIGNATURE LINE: "I attempted to break this pipeline and <could / could not> beyond the findings above."
```
