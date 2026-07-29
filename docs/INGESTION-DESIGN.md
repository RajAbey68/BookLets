# Ingestion Design — the sandbox-first rule

**Status:** normative. If code contradicts this document, the code is wrong.

This exists because the rule below lived in one person's head and in one of
three code paths. On 2026-07-29 a WhatsApp import wrote 135 entries straight
into the ledger, bypassing the review stage entirely, and 52 of them duplicated
receipts already staged. Nothing in the repository said the stage was mandatory,
so an agent working carefully still went straight past it.

---

## The rule

> **Nothing reaches the ledger without passing through the sandbox first.**
>
> Receipts and payments are ingested into `sandbox.*`, reviewed by a human, and
> only then booked into `public."JournalEntry"`. Every ingest path obeys this.
> There is no fast path, no exception for "clean" data, and no exception for
> high model confidence.

```
  source ──▶ sandbox.* ──▶  HUMAN REVIEW  ──▶ public."JournalEntry"
 (WhatsApp,   staging        (four-eyes)         the ledger
  OCR, bank                                    DRAFT → POSTED
  statement)
```

**Deadline:** a period is reviewed and booked by **month-end + 3 days**.
**Financial year:** 1 April → 31 March, closing monthly. The governing date is
the **finish date** — receipt date for expenses, checkout date for bookings.

---

## Why the sandbox exists (it is not a staging convenience)

1. **It is where deduplication actually works.** Ledger-side dedup is
   content-addressed on source bytes. A receipt photographed twice, or entered
   by hand, or OCR'd by a different path, has no matching hash — so the ledger
   cannot recognise it. The sandbox compares on *business* identity (amount,
   date, vendor), which is the only comparison that catches a duplicate a human
   would call a duplicate.

2. **It is where an AI's output stops being a decision.** Extraction is a claim
   about a document. Categorisation, a derived date, or "this is not a receipt"
   are judgements. Judgements are reviewed in the sandbox; they never arrive in
   the ledger pre-accepted.

3. **It is reversible.** Deleting a staged row costs nothing. Unpicking a posted
   journal entry costs an adjusting entry and an explanation.

---

## The three ingest paths, and what each must do

| Path | Entry point | Correct behaviour |
|---|---|---|
| **OCR bridge** | `/api/ingest/ocr-bridge` | ✅ Stages, parks with reasons |
| **Bank statement** | `/api/ingest/statement` | ✅ Dedups per transaction |
| **WhatsApp zip** | `/api/ingest/item` | ❌ **Writes straight to the ledger** |

The WhatsApp path is the outlier and the source of the 2026-07-29 incident. It
must be routed through `sandbox.*` like the others.

---

## Park reasons — the vocabulary for "held, not lost"

Anything that cannot be booked is **parked with a reason**, never dropped and
never guessed into shape. These already exist in `ocr-bridge.ts` and are the
canonical set:

| Reason | Meaning |
|---|---|
| `NO_DOC_DATE` | No date on the document |
| `NO_FISCAL_PERIOD` | Date outside an open accounting period |
| `BAD_AMOUNT` | Amount missing, zero or negative |
| `FX_UNSUPPORTED` | Not LKR — the books are LKR-only |
| `OCR_FAILED` | The document could not be read |

A parked row is visible and actionable. "88 could not be imported" with no
reasons is not a report, it is a shrug.

---

## Invariants — break these and the books are wrong

**1 · Dates are never fabricated.**
Precedence: **receipt date → photo/WhatsApp date → park as `NO_DOC_DATE`.**
A derived date is permitted *only* if it is labelled as derived, carries its
source, and is confirmed by a human before booking. Silently substituting
"today" is what put 83 entries (~15M LKR) in the wrong month.

**2 · Dates are never clamped into an open period.**
If no open period covers the date, park it. Do not move the date to fit.

**3 · Currency comes from the account, never a schema default.**
`JournalLine.currency` defaults to `"EUR"`. The books are LKR. An omitted
currency silently stamped EUR onto 270 lines. Always set it explicitly from the
account being posted to. Non-LKR documents park as `FX_UNSUPPORTED`.

**4 · Everything an AI touched lands as DRAFT and needs four eyes.**
No confidence score promotes anything. `agentConfidence` informs the reviewer;
it never substitutes for one.

**5 · Nothing vanishes.**
Every input ends in exactly one of: created, duplicate, parked (with reason), or
failed (with reason). The totals must reconcile against the input count.

**6 · Errors are classified before they are reported.**
An upstream provider's 429 is not "the receipt is unreadable". Classify on the
response body, and never let an infrastructure fault become a verdict on a
document. See `src/lib/ocr-errors.ts`.

---

## Deduplication order (this direction matters)

When reconciling staging against the ledger, **the ledger is authoritative only
for entries that were properly booked through review.**

If entries reached the ledger by bypassing the sandbox, they are the untrusted
copy. Remove *those* first, then dedup staging against what remains. Deduping in
the wrong direction deletes the reviewed copy and keeps the unreviewed one.

---

## For agents working in this repository

Before adding or changing any ingest path, confirm:

- [ ] Does it write to `sandbox.*` rather than `public."JournalEntry"`?
- [ ] Does every rejected input carry a park reason from the canonical set?
- [ ] Does it ever construct a date the source document does not contain?
- [ ] Does every journal line set `currency` explicitly?
- [ ] Do the outcome counts reconcile against the input count?
- [ ] Is every AI-derived value distinguishable from an extracted fact?

If you cannot answer all six, the change is not ready.
