# RESUME — ledger correctness repair

A fresh session must not rely on memory of the previous one. Re-verify first:

```
git rev-parse main            # expect bc2147734bc5ae792f0b451394e7875d3074cb46
git branch --show-current     # expect fix/ledger-repair-2026-11-13
git diff --stat main          # expect only docs/runs/ledger-repair-2026-11-13/*
shasum -a 256 src/lib/ledger.service.ts src/lib/books-view.ts
```

Expected source hashes (unchanged from base):

- `src/lib/ledger.service.ts` — see EVIDENCE.md "Source hashes"
- `src/lib/books-view.ts` — see EVIDENCE.md "Source hashes"

## Approval state

- No source file changed. No test added. Nothing pushed.
- Reviewer route: EGM reviewer agents are present in Claude Code; the `typesafe-jev` decision tools were NOT present in the 13 Nov session. No reviewer gate was claimed as passed.
- Held permissions candidate: its file manifest was not available. Any future edit to `src/lib/ledger.service.ts` needs that manifest checked first (the file holds the draft-edit path that editor tracking would plausibly touch).

## Decisions needed from Raj before any fix

### R1 — what does "reverse" mean in these books?

Today `reverseEntry` posts a counter-entry AND marks the original VOIDED. Every report reads POSTED only, so the original drops out and the counter-entry stays: the net effect is minus the original, not zero.

- Option A (true reversal): original stays POSTED, counter-entry POSTED, linked. Net zero. Matches FRD N-01 "Zero deletions. Reversals only." Needs an existing test assertion ("marks the original entry VOIDED") to change.
- Option B (void): original VOIDED, no counter-entry. Net zero. Removes the dated counter-entry from the audit trail.
- Option C: keep both writes, and change every report to count reversed originals. Touches files outside this assignment.

### R2 — what date and period does a reversal carry?

Today the counter-entry is dated "now" and skips the fiscal-period check. The trigger migration calls tightening this "a separate policy decision".

### R3 — what is the rule for a journal entry whose lines are in different currencies?

- Option A: reject at posting (books are LKR-only; importers already park non-LKR as FX_UNSUPPORTED).
- Option B: require debits = credits per currency.
- Option C: convert at a transaction-date rate (FRD B-07, not built; no rate source exists).

### R4 — what currency is a line that was written without one?

Production column default is reported as still "EUR" (migration `20260802_currency_default_lkr` not applied), and booking/receipt paths write lines with no currency. Any rule under R3 misfires on those rows until this is settled.

### R5 — may the fix extend beyond the two allowed files?

The raw cross-currency sums that feed the Trial Balance, Balance Sheet, P&L and dashboard metrics live in `trial-balance-report.ts`, `balance-sheet-report.ts`, `pl-statement-report.ts` and `metrics.service.ts`, none of which read `currency` at all. The /books row total needs either a `BookRow` shape change or a page change to show "Mixed currencies".

## Single next action

Raj answers R1 and R3 (and supplies the held candidate's file list). Then resume at step 5: write the failing tests for the chosen rules, after an EGM design review.
