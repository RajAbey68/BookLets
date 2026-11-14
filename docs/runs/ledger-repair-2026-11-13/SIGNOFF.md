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
6. **Held permissions candidate.** Supply its file list, so edits to `src/lib/ledger.service.ts` can be checked for overlap.

Approver: ____________  Date: ____________  Conditions: ____________
