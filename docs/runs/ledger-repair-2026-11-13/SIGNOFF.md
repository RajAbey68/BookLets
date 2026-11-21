# SIGN-OFF — ledger reversal and mixed-currency repair

Baseline `bc2147734bc5ae792f0b451394e7875d3074cb46`. Branch `fix/ledger-repair-2026-11-13`.

| Gate | Status |
|---|---|
| G0 plan drafted | done |
| G1 three independent reviews | first round Implementation Gate **BLOCK**; second round result recorded in `REVIEW-LOG.md` |
| G2 Jev Vision visual acceptance | not applicable (no rendered output) |
| Jev decision check | done — three answers in the "act" band, one REVIEW_PENDING (0.74) |
| G3 plan revised | done for every finding the author can close |
| G4 owner sign-off | six rule decisions answered by the owner 14 Nov 2026 |
| Implementation | done — PR 181, merged 15 Nov 2026 as `f757d8a` (was "not started" when this table was first written) |

## Owner decisions — answered 14 Nov 2026

| # | Question | Owner's answer |
|---|---|---|
| 1 | Reversal rule | Keep the original POSTED and add a linked counter-entry |
| 2 | Repeat reversal of the same entry | Return the existing counter-entry |
| 3 | Currency rule at posting | Same currency on all lines (no ruling on lines with no currency) |
| 4 | Counter-entry date | Today, and today must be in an open fiscal period |

| 5 | Reversing an old entry whose own lines are in mixed currencies | Mirror it exactly |
| 6 | Reversing a counter-entry | Refuse |

Note on answer 3: the option the owner chose read "Refuse only entries that mix currencies (or mix stated and blank). Makes no ruling on blank lines". So a set that mixes a stated currency with blank ones is refused (test C-2), and a set with no currency on any line is accepted exactly as before (test C-4); what currency a blank line means is left unruled.

Answers were given by the owner in the working session on 14 Nov 2026 through its question prompts.

## Held work

6. **Held permissions candidate — file list received 14 Nov 2026 (kept outside this repository).** Overlap check against the planned edits:
   - `src/lib/ledger.service.ts` is in both. The held work touches `updateDraftEntryFields` (from line 556 at base); this repair touches `validateTrialBalance` (50-74) and `reverseEntry` (357-439) only. Different regions, no authorization, role or editor-tracking logic in either repaired function. Both efforts edit the file, so whoever lands second must merge.
   - Test files this repair edits (`journal-reverse-entry.test.ts`, `ledger-service.test.ts`, `journal-idempotency.test.ts`) are not in the held list.
   - One caller of `validateTrialBalance` sits in a held file (`src/app/actions/approval.actions.ts:227`). It passes lines without currency, so the new check does not change its result at base; if the held work changes that call, re-check.
   - Result: file-level overlap only, no semantic overlap found. This is the author's check, not an independent certification.

Approver: the owner (answers above). Date: 14 Nov 2026. Conditions: scope limits of the assignment unchanged; release and data changes keep their separate gates.
