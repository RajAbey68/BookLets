# SIGN-OFF — ledger reversal and mixed-currency repair

Baseline `bc2147734bc5ae792f0b451394e7875d3074cb46`. Branch `fix/ledger-repair-2026-11-13`.

| Gate | Status |
|---|---|
| G0 plan drafted | done |
| G1 three independent reviews | done — Implementation Gate **BLOCK** |
| G2 Jev Vision visual acceptance | not applicable (no rendered output) |
| Jev decision check | done — three answers in the "act" band, one REVIEW_PENDING (0.74) |
| G3 plan revised | done for every finding the author can close |
| G4 owner sign-off | **UNSIGNED** |
| Implementation | not started |

## Owner decisions required (author's recommendation first)

1. **Reversal rule.** Keep the original posted and add a linked counter-entry, one reversal per entry. (Jev 1.00.)
2. **Repeat reversal of the same entry.** Return the existing counter-entry (no second entry, no error). Alternative: refuse with an error.
3. **Reversing an old entry whose own lines are in mixed currencies.** Mirror it exactly so it nets to zero. Alternative: refuse.
4. **Currency rule at posting.** Refuse an entry whose lines are not all in the same currency. Stricter alternative: LKR-only posting, which also needs a ruling on lines written with no currency (booking and receipt paths omit it; production's column default is recorded as EUR).
5. **Counter-entry date.** Keep "today" and add the existing open-period check so a closed current period gives a clear refusal. Alternative: leave unchanged (the database trigger still refuses, with a raw error).
6. **Held permissions candidate — file list received 14 Nov 2026 (kept outside this repository).** Overlap check against the planned edits:
   - `src/lib/ledger.service.ts` is in both. The held work touches `updateDraftEntryFields` (from line 556 at base); this repair touches `validateTrialBalance` (50-74) and `reverseEntry` (357-439) only. Different regions, no authorization, role or editor-tracking logic in either repaired function. Both efforts edit the file, so whoever lands second must merge.
   - Test files this repair edits (`journal-reverse-entry.test.ts`, `ledger-service.test.ts`, `journal-idempotency.test.ts`) are not in the held list.
   - One caller of `validateTrialBalance` sits in a held file (`src/app/actions/approval.actions.ts:227`). It passes lines without currency, so the new check does not change its result at base; if the held work changes that call, re-check.
   - Result: file-level overlap only, no semantic overlap found. This is the author's check, not an independent certification.

Approver: ____________  Date: ____________  Conditions: ____________
