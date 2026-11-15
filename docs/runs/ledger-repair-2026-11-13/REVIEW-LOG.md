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

## Second and third rounds (14 Nov 2026)

- Round 2, after the owner's first four answers: **IMPLEMENTATION GATE — BLOCK**, 7 findings (P1 1, P2 3, P3 3). The P1 was three rules still without an owner answer (reverse a mixed-currency original; reverse a counter-entry; stated-plus-blank currency). The owner answered the first two; the third was already covered by the wording of the option the owner chose. The other six findings were changed in the plan (mixed-original row R-16, sequenced lookup for R-10, exact total of 998, test-file range, R-1 wording, R-15 date tie).
- Round 3: **IMPLEMENTATION GATE — PASS**, 4 non-blocking P3 findings; three changed (blank-string wording, stale pointers, books-view note), one deferred (sign-off sheet layout). The reviewer's stated limits: it takes the owner's answers as recorded by the author, and it executed nothing.

## Code review of the fix (15 Nov 2026)

Three independent zero-context EGM reviewers read the diff (`main`..`36d0189`, source and tests) and the surrounding code. Read-only; none executed the suite.

| Reviewer | Findings | Result |
|---|---|---|
| Critic (defects) | 6 (P2 2, P3 4) | no code change required for correctness against the rules; two database checks required before release |
| Technical accuracy and test integrity | 9 (P2 2, P3 7) | no existing assertion weakened beyond the flagged replacement; one misleading test title, one untested branch |
| Scope and simplicity | 4 (P2 1, P3 3) | SCOPE OK; plan wrongly said no rendered output changes |

No P0 or P1 from any reviewer.

| Finding | Disposition |
|---|---|
| Listings show a reversed entry as two POSTED rows; plan section 8 was wrong | changed — section 8 corrected, residual recorded (section 10); display change needs owner approval, outside permitted files |
| One-reversal rule depends on the unique index under concurrency | deferred to owner — confirm the index in production; an in-transaction row lock was suggested and not added (new behaviour, not in the approved rules) |
| Cancellation refused when no open period covers today | deferred to owner — consequence of the approved date rule; recorded in section 10 |
| C-8 title claimed "before touching the database" | changed — retitled; now asserts the single idempotency read |
| "P2002 with no winner is rethrown" untested; recovery lookup scope unasserted | changed — R-17 added; R-10 asserts the lookup's `where` |
| P2002 without `meta.target` (driver adapter shape) untested | changed — R-18 added |
| Repeat-call and lost-race results lacked `lines` | changed — both lookups now `include: { lines: true }` |
| Line mapping duplicated inside `create` | changed — `reversedLines` passed directly |
| R-15 could flake (clock read before a cold import) | changed — clock read around the call only |
| C-7 and R-6 titles claimed more than shown | changed — retitled |
| Key comment true only if the original's date is not edited | changed — comment qualified |
| Period check outside the transaction; empty-string currency; duplicate currency definition; seed scripts bypass | deferred — recorded in section 10 |
| Error-message wording unpinned | rejected — presentation only |

After these changes: `npm run test:unit` 1000 passed (65 files), 0 failed, same single pre-existing unhandled error; `npx tsc --noEmit` exit 0; eslint on the changed files with `--max-warnings 0` exit 0.

### Third-party model review

DeepSeek V4.1 Flash, the requested reviewer: BLOCKED, not run (the OpenRouter workspace allows nine free models only). On the owner's instruction two allowed models reviewed the diff at `7e2151b` instead: NVIDIA Nemotron 3 Ultra (verdict REJECT) and Cohere North Mini Code (APPROVE WITH FIXES, output truncated). After triage none of their findings requires a change; verbatim outputs and dispositions are in `THIRD-PARTY-REVIEW.md`.

### CI on the pull request

On commit `36d0189` the `Build & Lint` job ran Typecheck, Lint, Unit tests + coverage gate and Build successfully (Node 20), then failed at its last step, `npm audit` (16 dependency advisories: next, sharp, postcss and others). The same job fails on `main` at the base commit, so the failure is not caused by this change. Integration tests, schema validation, governance gates, dependency review and Snyk passed. The follow-up commit with the review fixes has its own CI run.
