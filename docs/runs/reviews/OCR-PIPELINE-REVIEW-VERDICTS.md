# Adversarial Review Verdicts — Receipt OCR Pipeline

Three independent adversarial reviewers attacked
`EXTERNAL-REVIEW-PACKET-ocr-pipeline.md` **and verified every claim against the
actual pipeline source + Prisma schema** (a context-free external model cannot
do the latter). Verdicts are recorded verbatim-in-substance below, then
synthesised into corrections applied to `OCR-PIPELINE-QA-REVIEW.md` (v2).

> Reviewers were Claude-based adversarial agents, code-verified. They are **not**
> the external Gemini/GLM/Grok models the packet is addressed to; the packet
> remains ready for a cross-vendor pass if desired.

## Verdicts

| Reviewer | Lens | Verdict |
|---|---|---|
| R1 | Correctness + accounting | PASS-WITH-CONDITIONS |
| R2 | Security + multi-tenancy | **FAIL** |
| R3 | Completeness critic | Central claim HOLDS-WITH-CAVEATS |

## What the review got RIGHT (confirmed against code)
- **F1 (double-book)** — CONFIRMED HIGH by R1+R3. `automation.service.ts:178-195`
  passes no `idempotencyKey`; `ledger.service.ts` skips the dedup lookup when it
  is undefined, so every call creates a new entry. ZIP path passes it.
- **F2 (date fabrication)** — CONFIRMED HIGH. `ocrDateOrNow` returns *today*
  (`zip-ingest.ts:405-411,491`) where the bridge parks `NO_DOC_DATE`.
- **F3 (no reconciliation)** — CONFIRMED, and R3 strengthened it: the fix is not
  merely "unbuilt" but **structurally unrepresentable** — `GeminiExtraction`
  (`gemini-ocr.ts:21-27`) has no `lineItems`/`subTotal`/`grandTotal`/tender
  fields, so rules C1–C6 have no data to run on until the schema is extended.
- Always-DRAFT gate + 4-eyes hold on all three paths (R3 confirms the central
  claim's core).

## Corrections the review REQUIRED (my findings were wrong or understated)

### C-1 — F6 is HIGH, not MED, and it's a SCHEMA defect (R2, blocking)
`ExpenseCategory` and `Vendor` have **no `organizationId` column**
(`prisma/schema.prisma:292-307`). They are global tables resolved by unanchored
`contains` (`automation.service.ts:130-132`). Because a category's `accountId`
points at an org-scoped `Account`, Org B's receipt can reuse a category row
created by Org A → Org B's DRAFT line is built against **Org A's GL account**
(`automation.service.ts:144,192`). This is live **cross-tenant ledger
contamination**, one approval from POSTED. My "add an `organizationId` filter"
fix is **unimplementable** without a migration — I mis-described a schema defect
as a query bug. → **Raise F6 to HIGH.**

### C-2 — `contains: undefined` is a no-op filter (R2, blocking)
The inline SymbiOS fallback assigns `vendorName` raw with no validation
(`automation.service.ts:81-87`). A missing name makes
`vendor.findFirst({ where: { name: { contains: undefined } } })` drop the
predicate and return the **first vendor in the global table** — any tenant's.

### C-3 — Currency default is EUR, not LKR (R2, corrects F4)
Ledger lines pass no currency; `JournalLine.currency` **defaults to "EUR"**
(`prisma/schema.prisma:196`). An LKR receipt is stamped **EUR**, not "booked as
LKR." And currency is absent from the extraction schema entirely
(`gemini-ocr.ts:21-27`), so non-LKR is **structurally undetectable** on the
single/ZIP paths (the bridge only parks FX because it reads a staging DB column).

### C-4 — F5 wording overstated (R1, non-blocking)
`validateExtraction` normalises the direct-path date to `YYYY-MM-DD` or `""`
(`gemini-ocr.ts:164-176`); `new Date("")` → Invalid Date **throws** in
`postEntry`, it does **not** store garbage. Real harm = late crash **after**
orphaned `vendor`/`expenseCategory` rows are written outside the transaction
(`automation.service.ts:110-142`). Reword; keep MEDIUM.

### C-5 — the reconciliation rules contradict themselves (R1, blocking)
**C.5 (digit-drop guard) and C.6 (discard tender) cancel out.** When one price
column is uniformly mis-OCR'd, line items *and* printed total lose the same
leading digit together, so C.5's cross-check reconciles a wrong number:
```
Rice 5kg  1,159 → 159    sum(159+328)=487 == TOTAL-as-read 487  → C.5 PASSES
Dhal 2kg    328 → 328    but true total = 1,487
TOTAL     1,487 → 487    only CASH−CHANGE (2,000−513=1,487) catches it
CASH      2,000          — the very figure C.6 says to discard.
```
**Fix:** reconcile goods total against `cash_paid − change` as an independent
third figure; do not discard tender.

### C-6 — loyalty points used as *tender* still defeats C.1+C.4 (R1, blocking)
```
Goods Subtotal   12,458      C.1 picks NET TOTAL 10,316 and under-books the
Points Used      -2,142      expense by 2,142 — the exercise's error, inverted.
NET TOTAL        10,316      C.4 excludes the loyalty line but never adds it
CASH             10,316      back as tender to reconstruct goods value.
```
**Fix:** goods value = gross subtotal; points redemption is a separate
income/liability offset, not a reduction of the expense. Classify loyalty lines
as **tender-offset**, not merely "not the total."

### C-7 — tolerance cannot be a single percentage (R1)
Any blind % band wide enough to survive 50 weighted lines + VAT + a coupon also
passes a genuine double-count of a small item. Reconcile **structurally**
(`Σlines − discounts + tax == total`) with tolerance only for per-line rounding
(±0.5 × weighted-line-count).

## NEW findings beyond F1–F8 (add to the review)

### F9 — HIGH — ZIP path can post a zero-amount entry that violates the ledger's own invariant (R3)
The ZIP path has **no positive-amount guard** (`zip-ingest.ts:501-504`), unlike
the single path (`automation.service.ts:102`) and bridge (BAD_AMOUNT park). A
malformed OCR response defaults `totalAmount:0` (`gemini-ocr.ts:78-84`) → a 0.00
DRAFT is created. `LedgerService.postEntry` only runs the "no zero-amount lines"
check for POSTED (`ledger.service.ts:238-247`), and DRAFT→POSTED approval flips
status via a raw `updateMany` (`approval.actions.ts:248-251`) that re-checks only
trial-balance (0=0 passes) and fiscal period — **never re-applying the zero-line
check.** A rubber-stamped "trivial" 0.00 becomes a compliance-forbidden POSTED
entry.

### F10 — MED — ZIP path never calls `gateAutomatedJournalEntry` (R3)
`zip-ingest.ts:489-505` hardcodes DRAFT and forwards `agentConfidence` raw; the
single path and bridge gate confidence and throw on NaN/<0/>1. With the
unvalidated SymbiOS fallback (`gemini-ocr.ts:144-145`), an out-of-range/NaN
confidence reaches the ledger row with no loud failure. F7's root cause is the
**path lacking a gate backstop**, not just one extractor being unvalidated.

### F11 — LOW — malformed-JSON fabricates a confidence from the OCR envelope (R3, reinforces F8)
On `JSON.parse` failure, `confidence: data.confidence || 0` (`gemini-ocr.ts:83`)
uses the microservice's **text-detection** confidence, not extraction
confidence — a garbage receipt (`totalAmount:0`) can still show the checker 0.9.

### Also flagged (non-blocking)
- Rate limiter is **per-process**; on serverless every cold lambda gets a fresh
  10-token bucket → effective cap N×10/min (`upload-guard.ts:14-18,173`). Remove
  it from the "strengths" list or caveat it.
- WhatsApp transcript text + participant names persisted to the evidence log
  (`zip-ingest.ts:527-542`) — PII retention, unflagged.

## Test-coverage gaps (R3)
1. `gemini-ocr.ts` has **no unit test** — microservice call, malformed-JSON
   branch, `validateExtraction`, and the unvalidated SymbiOS fallback all untested.
2. `zip-ingest.test.ts` only feeds `totalAmount: 4500` — no zero/negative/NaN or
   malformed-extraction case (F9/F10 unguarded).
3. No test asserts DRAFT→POSTED approval rejects zero-amount lines (it doesn't).
4. No fiscal-period test on the single/ZIP paths.

## Synthesised severity table (post-review)

| # | Was | Now | Note |
|---|-----|-----|------|
| F1 | HIGH | HIGH | confirmed |
| F2 | HIGH | HIGH | confirmed; only ZIP fabricates *today*, single path is Invalid-Date (F5) |
| F3 | HIGH | HIGH | strengthened — structurally unrepresentable until schema extended |
| F4 | MED | MED | corrected: stamps **EUR**; currency absent from extraction schema |
| F5 | MED | MED | reworded: late crash + orphaned master-data, not stored garbage |
| F6 | MED | **HIGH** | schema defect → cross-tenant GL contamination + `contains:undefined` |
| F7 | LOW/MED | MED | both fallbacks unvalidated; ZIP path has no gate (see F10) |
| F8 | LOW | LOW | reinforced by F11 |
| **F9** | — | **HIGH** | zero-amount DRAFT → POSTED bypasses zero-line invariant |
| **F10** | — | MED | ZIP path skips `gateAutomatedJournalEntry` |
| **F11** | — | LOW | fabricated confidence on malformed JSON |

## Strongest single risk (R3) + top remediation
A malformed/zero bulk extraction becoming a **POSTED zero-amount entry that
violates the ledger's own compliance invariant** (F9). Highest-leverage fix:
route **all three** ingestion paths through **one shared pre-post guard**
(positive amount + confidence gate + currency/reconciliation), **and** re-run the
zero-amount-line check inside the DRAFT→POSTED approve branch so approval enforces
the same invariants as a direct `postEntry` — closing the `updateMany` bypass.

## Net
The security lens returned **FAIL**: F6 is a HIGH cross-tenant defect, not a MED
merge annoyance, and F9 is a new HIGH. The reconciliation rules (the exercise's
core lesson) have an internal contradiction and are unrepresentable in today's
schema. Recommendation: **do not treat the pipeline as review-complete** — the
v2 corrections and F9/F10/F11 must land, and the shared-guard remediation should
be the first code change, ahead of the C1–C6 reconciliation work (which needs a
schema extension first).
