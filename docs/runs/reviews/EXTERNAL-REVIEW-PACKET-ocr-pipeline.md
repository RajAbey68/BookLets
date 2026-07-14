# EXTERNAL ADVERSARIAL REVIEW PACKET — Receipt-Image → Ledger OCR Pipeline

**To the reviewing model (Gemini / GLM / Grok / Hermes):** You are an
independent, adversarial reviewer. You have NO access to the repository or
database — this packet is self-contained. Your job is to find where this
pipeline books WRONG, DUPLICATE, or MIS-DATED money into an accounting ledger,
and to break the proposed reconciliation rules before they ship. Do not be
polite. If you cannot break a claim, say so explicitly and sign the verdict.

## A. Context (verified facts, read from source)
- BookLets books in **LKR**. Receipt photos become **DRAFT** journal entries;
  DRAFT→POSTED happens only via human 4-eyes sign-off. No confidence score
  (including 1.0) can auto-post — this is enforced at compile time by a gate
  with no POSTED branch. This part is sound and is NOT what we're asking you to
  attack.
- There are **two ingestion paths** to the same ledger:
  - **Single upload** (WEB/MOBILE): `AutomationService.processReceipt` →
    extract → create Expense + JournalEntry.
  - **Bulk**: ZIP ingest and a staging→ledger bridge over ~468 OCR'd rows.
- Extraction returns a flat object per receipt:
  `{ vendorName, date (ISO or ""), totalAmount (number), categorySuggestion,
  confidence (0–1) }`. A shared OCR microservice produces it, with a SymbiOS
  service as fallback.
- This review was triggered by a real exercise: a human-consolidated total of
  7 receipts came out wrong **four** independent ways — (a) subtotal **and**
  line items both summed; (b) a loyalty "you saved Rs. 2,142" line read as the
  bill total when the real total was ~Rs. 12,458; (c) dropped leading digits
  (159 vs 1,159; 28 vs 328); (d) "cash paid"/"balance" read as the goods total.
  A naive re-scan reached ~37,000 vs a true ~23,000 by counting intermediate
  and restated lines.

## B. Artifact 1 — findings already identified (confirm, refute, or extend)
Severity is ours; challenge it.

- **F1 (HIGH):** the single-upload path has **no idempotency/content-hash
  dedup** (the ZIP path dedups by image `sha256`). Same receipt uploaded twice
  → two Expenses + two DRAFT entries = double-booked purchase.
- **F2 (HIGH):** date policy diverges. The bridge PARKS a dateless receipt and
  never fabricates a date. The ZIP path substitutes **today** (`ocrDateOrNow`)
  when the date is missing/unparseable; the single path passes `new Date("")`.
  A missing receipt date silently becomes the ingest date → wrong fiscal period.
- **F3 (HIGH):** **no total reconciliation**. Only a single `totalAmount` and a
  self-reported `confidence` are captured; nothing cross-checks the total
  against line items / subtotal / tender. All four exercise failure modes pass
  silently, and the checker sees a misleading "0.95".
- **F4 (MED):** currency not enforced on the direct/ZIP paths — a non-LKR
  receipt's raw number is booked as LKR (the bridge parks non-LKR; the other
  paths don't). 11 non-LKR rows are known to exist.
- **F5 (MED):** invalid/empty date can reach the ledger on the direct path
  (amount is guarded up front; date is not).
- **F6 (MED):** vendor/category matched by **unanchored `contains`**, and the
  vendor lookup has **no `organizationId` filter** → wrong-record merge and
  cross-tenant vendor reuse.
- **F7 (LOW/MED):** the SymbiOS fallback extraction skips the validator/clamp
  the microservice path runs — two extractors, one validated.
- **F8 (LOW):** confidence is decorative (never gates), so an unreliable scan is
  indistinguishable from a clean one in the queue.

## C. Artifact 2 — reconciliation rules proposed to fix F3 (attack these)
To be enforced in the extraction prompt AND a pure guard the pipeline runs on
every extractor's output:

1. One amount per receipt = the printed **GRAND/NET TOTAL** (payable), counted once.
2. Never sum line items on top of a printed total; never add SUBTOTAL+TOTAL or
   GROSS+NET+CASH PAID.
3. Line items are a cross-check only: sum them, compare to the printed total;
   on mismatch beyond tolerance, lower confidence and flag — never adopt the larger.
4. A loyalty / "you saved" / points line is not the total.
5. Guard dropped leading digits by comparing magnitude to the line-item sum.
6. "Cash paid" / "change" / "balance" are tender, not the bill.
7. One physical slip = one receipt; multiple slips = multiple receipts.
8. Never fabricate dates — park/reject when absent, on every path.
9. Enforce currency — park non-LKR on every path.
10. Dedup by content hash on every path.

## D. Claim under review
"Behind the always-DRAFT + 4-eyes gate, the ledger cannot be *posted* to
unreviewed, so the residual risk is entirely (i) silent **duplicates** and
**mis-dates** entering the review queue, and (ii) a **wrong total** presented to
the checker with false confidence. Fixing F1–F3 closes the material risk; F4–F8
are hardening."

## E. Attack this. Specifically:
1. **Reconciliation tolerance:** what tolerance for "line items ≈ printed total"
   avoids both false flags (rounding, per-line tax, weight×price like
   2.19 kg × 150) and false passes (a genuine double-count)? Give a rule that
   survives receipts with discounts, per-item VAT, and mixed tax lines.
2. **Which figure is authoritative** when a receipt prints SUBTOTAL, DISCOUNT,
   GRAND TOTAL, CASH, and CHANGE, and two of them are equal by coincidence?
   Can you construct a real receipt layout where rule C.1 picks the wrong line?
3. **Loyalty-line detection (C.4):** rule by keyword, by position, or by
   arithmetic (doesn't participate in the sum)? Show a layout that defeats your
   choice — e.g. "You saved" printed in a language the extractor doesn't key on.
4. **Digit-drop guard (C.5):** if line items are themselves mis-OCR'd, the
   cross-check validates a wrong total against wrong parts. How do you keep the
   guard from laundering a consistent-but-wrong extraction?
5. **F1 idempotency by image `sha256`:** what legitimately produces two
   *different* hashes for the *same* purchase (re-photo, crop, recompress,
   EXIF-strip) and thus still double-books? Is content hash the right key, or
   should it be (vendor, date, total)? Trade-offs?
6. **F2 date policy:** is refusing to fabricate dates correct accounting
   practice, or should there be a *disclosed* fallback (file mtime, upload
   date)? If parking, does 100%-park-on-missing-date create an ops backlog that
   pressures someone to fabricate anyway?
7. **F6 vendor scoping:** beyond adding `organizationId`, is substring matching
   ever safe for vendor resolution, or must it be exact + alias table? What
   breaks each way?
8. **Reconciliation vs confidence (F3/F8):** should a failed reconciliation
   BLOCK draft creation, or create the draft with a loud flag? Argue the
   accounting-safe default and the failure mode of the other choice.
9. **General:** what is the most damaging thing this pipeline could do to a
   production accounting ledger, and what single change most reduces that risk?

## F. Required verdict format (paste back verbatim)
```
REVIEWER: <model name/version>
VERDICT: PASS | PASS-WITH-CONDITIONS | FAIL
BLOCKING FINDINGS: <numbered, each with a concrete failure scenario / receipt layout>
NON-BLOCKING FINDINGS: <numbered>
DISPUTED SEVERITIES: <which of F1–F8 you would raise/lower, and why>
ANSWERS E1–E9: <one line each>
SIGNATURE LINE: "I attempted to break this pipeline and <could / could not> beyond the findings above."
```
