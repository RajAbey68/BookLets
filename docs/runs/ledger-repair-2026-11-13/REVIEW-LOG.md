# REVIEW LOG — test plan for ledger reversal and mixed-currency repair

Reviews run 14 Nov 2026 against `TEST-PLAN.md` at commit `8548769`. Three independent zero-context reviewers (EGM agents), read-only. Plus a TypeSafe Jev decision check on the two rule choices.

## Gate status

**G1: IMPLEMENTATION GATE — BLOCK.** 48 findings: Critic 15 (P1 7, P2 6, P3 2), Naive Reader 22 (P1 8, P2 10, P3 4), Implementation Gate 11 (P0 1, P1 5, P2 4, P3 1). The P0 and four other findings need the owner's answer; they cannot be closed by the author. No test or source code has been written.

## Jev decision check (model `jev-1.14.0`)

| Question | Answer | Confidence | Band |
|---|---|---|---|
| Reversal rule | keep original posted + linked counter-entry | 1.00 | act |
| Does that net to zero in POSTED-only reports? | yes | 0.97 | act |
| Currency rule | reject mixed-currency entries | 0.97 | act |
| Does rejecting mixed entries stay within constraints? | yes | 0.74 | REVIEW_PENDING |

Jev Vision (visual acceptance): not applicable, no rendered output changes.

## Findings and dispositions

IDs: C = Critic, N = Naive Reader, I = Implementation Gate.

| Finding | Summary | Disposition |
|---|---|---|
| I1 (P0) | D1-D5 are author recommendations under a general "proceed"; owner has not confirmed each | **deferred to owner** — blocks |
| C3, N5, I10 | Repeat reversal: refuse with an error, or return the existing counter-entry | **deferred to owner** — blocks. Reviewer evidence favours returning the existing counter-entry (lets the cancellation caller finish its own bookkeeping) |
| C7, I7 | Reversing an old mixed-currency original is unspecified | changed (D4: mirror verbatim, exempt from D5); **owner to confirm** |
| C9, N7 | A stated currency mixed with omitted ones is refused although the schema default is LKR | changed (reason and caller check stated in D5); **owner to confirm**, tied to "LKR-only posting" question |
| C13 | Counter-entry dated today may fall in a closed period; raw database error | changed (listed in section 10); **owner to decide** whether to add a fiscal-period check |
| C6, N1, N16, C15, I10b | `getAccountBalance` throwing on mixed accounts is unworkable on real data | changed — D6 and tests C-9 to C-11 removed; function left as is and listed in section 7 |
| C1, N2, I4 | R-3 could not fail on the unfixed tree | changed — R-3 now sums only entries whose resulting status is POSTED |
| C10, N3, I3 | R-4 asserted currency but was listed as passing | changed — currency removed from R-4, R-5 owns it |
| I2 | R-2 listed as failing but passes today | changed — moved to the pass list |
| C2, N4, I5 | Shared fixture lacks `date`; "kept unchanged" tests would throw | changed — fixture change declared as a harness change |
| N13, I6 | No way to drive or observe the in-transaction lookup | changed — `mockDeps` signature and ordering assertion specified |
| C4, N6, I8 | Unique-index race gives a raw P2002 | changed — R-10 added (mapped to "already reversed"), R-11 pins other errors unchanged |
| N12 | Key recipe only in a test row | changed — recipe and reason now in D2 |
| N14 | Check order unspecified | changed — order stated |
| C8, N8 | D5 worded as an invariant | changed — reworded as a check on one write path, bypasses listed |
| C5 | Rollback not data-neutral | changed — section 9 rewritten |
| C5b, N9, N10 | Legacy reversed pairs and legacy counter-entries | changed — stated out of scope in sections 3 and 7 |
| C11 | R-1 pinned the unguarded memo write shape | changed — R-1 asserts only "no status change"; unguarded write listed in section 10 |
| C12 | Dead end if a counter-entry stops being counted | changed — listed in section 10 as accepted residual |
| I9, N17 | Green threshold not binary | changed — exact command, counts and exit code |
| I11, N15, C14a | Loose assertions in C-1, C-8, C-10 | changed — exact matchers; C-8 asserts no transaction and no fiscal-period read |
| N11 | "subtracted twice" unclear | changed — worked example |
| N18 | Undefined project terms | changed in part — header rewritten with pointers; remaining terms are defined in `EVIDENCE.md` |
| N19 | Zero balance for an invalid mixed set | rejected — callers read `error` when `isValid` is false (`ledger.service.ts:239-242`, `approval.actions.ts:227-232`) |
| N20, N22 | Test file mapping; comment edits | changed — mapping and permission stated |
| N21, C14b-e | Unpinned edge cases (null memo, three currencies, repeated accounts) | deferred — noted as unchanged-but-unpinned; not needed to prove the two defects |

## To flip the gate to PASS

1. Owner answers the questions in `SIGNOFF.md`.
2. Author folds the answers into `TEST-PLAN.md`.
3. Implementation Gate reviewer re-runs on the revised plan and returns PASS.
