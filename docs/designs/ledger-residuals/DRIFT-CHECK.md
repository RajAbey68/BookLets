# Drift check — ledger repair (PR 181, head `982e8e2`)

15 Nov 2026. Two zero-context EGM reviewers, static reading only (no test run, no git). Recorded here, on the roadmap branch, because the PR branch is frozen for review; nothing on the PR branch was changed.

**Update 17 Nov 2026:** PR 181 was merged. Section B's six P1 statements were corrected in the run notes in the same docs PR that adds this file (HANDOFF.md had already been corrected on `main` in `6a604ae`). Section A's P2/P3 items and section B's P2/P3 items are not corrected.

## A. Specification vs code — no behavioural drift

Verdict from the reviewer: P0 0, P1 0, P2 1, P3 7. The code does what owner decisions D1–D6 sign off. Every acceptance criterion (R-1…R-18, C-1…C-8) has a test, and no assertion is weaker than its criterion. No file under `src/` still assumes a reversed original becomes voided.

All drift is in documents, comments or untested-but-unchanged behaviour:

| ID | Sev | What | Where |
|---|---|---|---|
| F1 | P2 | Test plan section 6 still says green is "exactly 998" and "anything else is NOT green"; the head has 1000, and section 4 of the same file says 1000. R-17 and R-18 missing from the red/pass lists. | `TEST-PLAN.md:113`, `:104`, `:112` |
| F2 | P3 | R-17 and R-18 have no Given/When/Then row. R-18 does not assert that no evidence record is written (R-10 does). | `TEST-PLAN.md:49-67`; `tests/unit/journal-reverse-entry.test.ts:328-353` |
| F3 | P3 | Sign-off numbers the six decisions in a different order from the test plan, so "D3" means different things in the two files. | `SIGNOFF.md:19-25` vs `TEST-PLAN.md:27-32` |
| F4 | P3 | Sign-off still says "Implementation: not started" and cites pre-fix line ranges. | `SIGNOFF.md:13`, `:34` |
| F5 | P3 | Code treats a unique-constraint error with no target as an idempotency conflict, and assumes the original's date is not edited between attempts; neither is in the D2 text. | `src/lib/ledger.service.ts:163`, `:437-439` |
| F6 | P3 | D5 says posting "refuses" a mixed entry; a replayed idempotency key returns the existing entry before validation. Stated only in a test comment. | `src/lib/ledger.service.ts:247-260` |
| F7 | P3 | Three code comments are out of date (scope comment, docstring omits rethrow, test header says R-1..R-16). | `src/lib/ledger.service.ts:393-394`, `:371-373`; test file `:17` |
| F8 | P3 | Unchanged behaviours with no assertion: evidence record on success, counter-entry memo text, D3 checked before the D2 lookup, legacy counter-entries not recognised. The test plan already concedes the first two. | `TEST-PLAN.md:35` |

## B. Run documents vs actual state — drift, documents only

Verdict from the reviewer: 6 P1, 11 P2, 7 P3. Code scope: no drift (only the allowed files changed).

P1 — a reader following the document would act on a false statement:

| # | Stale statement | True now |
|---|---|---|
| 1 | `EVIDENCE.md:309-317` "Source hashes after the fix"; `HANDOFF.md:59` and `RESUME.md:59` tell the reader to check against them | Hashes were taken at `23aca91`; `b4d2e58` changed all four files. A correct tree gives four mismatches. |
| 2 | `HANDOFF.md:10-19` lists 9 commits; `:68` says 998 passed | 12 commits; 1000 passed. Describes the retired 9-commit patch. |
| 3 | `RESUME.md:59` latest state: fix `23aca91`, 998 passed | Omits `b4d2e58`; 1000 passed. |
| 4 | `EVIDENCE.md:321` "No pull request, merge or deploy"; a push "runs no GitHub workflow" | PR 181 is open; CI ran on it. |
| 5 | `SIGNOFF.md:13` "Implementation: not started" | Implemented, reviewed, in a PR. |
| 6 | `PLAN.md:6` "(local only, never pushed)" | Pushed; PR 181. |

P2 (stale but superseded later in the same file, or low risk): `PLAN.md:32,34`; `RESUME.md:8,12-15,19`; `EVIDENCE.md:185,216,220,222,233-234,239,269,277,284-286`; `TEST-PLAN.md:113`; `SIGNOFF.md:8,9`; `REVIEW-LOG.md:7,18`; `HANDOFF.md:28-31,39-44,74-76` (including C-8 described as a reversal test, which was wrong when written); `HANDOFF.md` not mentioning the pre-release checks or the outstanding DeepSeek review.

P3: `REVIEW-LOG.md:31,36,37,100`; `EVIDENCE.md:287`; titles of `PLAN.md` and `HANDOFF.md` say "multi-currency" without "partly".

Do the documents claim more than was done? Mostly no: the partial multi-currency fix, legacy pairs, the second cancellation route and the dependence on the production unique index are all disclosed in `TEST-PLAN.md` sections 7 and 10 and `EVIDENCE.md:325`.

## C. Disposition

- Code and tests: no change needed for drift. F7 (comments) and the optional extra assertion in F2 are candidates for a later tidy-up; neither changes behaviour.
- Documents: the six P1 items should be corrected before anyone uses the run notes to verify the candidate. Correcting them is a documents-only commit on the PR branch, which moves the reviewed tip from `982e8e2`. That is the owner's call; not done here.
- Until then: the pull request diff and its description are the reference, not `HANDOFF.md`, `RESUME.md` or the hash table in `EVIDENCE.md`.
