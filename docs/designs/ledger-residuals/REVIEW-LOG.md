# Review log — ledger residuals roadmap

## Round 1 — 15 Nov 2026, on ROADMAP.md rev 1

Three zero-context reviewers (EGM): Critic, Naive Reader, Implementation Gate. None is an independent human review.

| Reviewer | Verdict | Blocking |
|---|---|---|
| Critic | REVISE | 3 × P1 |
| Naive Reader | Owner could not answer most questions from the document alone | several P1 |
| Implementation Gate | **BLOCK** | 5 × P1 |

### Dispositions

| # | Finding | Source | Disposition in rev 2 |
|---|---|---|---|
| 1 | R2 misdescribed today's behaviour: route two runs in the same sync, and "post nothing and flag" is not what happens when route one finds nothing | Critic 1, Gate P2-1 | ACCEPTED. Verified at `src/lib/revenue.service.ts:78`, `:150-157`, `:286`, `:298`. R2 rewritten. |
| 2 | No "deployed to production" gate; a count before deployment goes stale | Critic 2, Gate P1-2 | ACCEPTED. Gate G-F added; R0 run of record after G-F; re-run before any R1 write. |
| 3 | R1 missing the option of reversing the legacy counter-entry with the tested function; option B's link and idempotency unstated | Critic 3, Gate P2-4 | ACCEPTED. Option E added; B's link and key stated. |
| 4 | R1 "done" ignores currency; legacy counter-entry lines took the default currency | Critic 4, Gate P2-4 | ACCEPTED. "Per account and per currency"; R3-Q1/Q3 made prerequisites. |
| 5 | R4 depends on R3-Q3 | Critic 5 | ACCEPTED. Stated as prerequisite. |
| 6 | R2 "at most one counter-entry per booking" wrong for cancel, reinstate, cancel; no lower bound; failure case unnamed | Critic 6, Gate P1-3 | ACCEPTED. Done-rule rewritten per pre-payment entry, with the two named scenarios. Same-day fast-path fault moved into R2 as R2-Q7. |
| 7 | R0 too narrow | Critic 7, Gate P2-3 | ACCEPTED. Six lists; evidence-log cross-check; output not committed; schema named; unparseable cases listed. |
| 8 | R1 missed consequences: voided rows deletable, direct SQL bypasses evidence log and version, option A hides pair from the R0 search | Critic 8 | ACCEPTED. In option table and R1-Q4. |
| 9 | R1 missing owner questions: issued statements, application vs SQL, backup | Critic 9 | ACCEPTED. R1-Q2, Q4, Q5. |
| 10 | G-C should include link-field columns and non-application of the loose trigger file | Critic 10 | ACCEPTED. |
| 11 | R3 file list incomplete | Critic 11 | ACCEPTED. `account.service.ts` added; `books.actions.ts` marked "to be checked" (not opened by the reviewer or by me). |
| 12 | Section 6 asks too little; omits review/merge/deploy; "two answers" was three | Critic 12, Reader §4, Gate P3 | ACCEPTED. Section 6 rewritten. |
| 13 | R1 "done" contradicts option D | Gate P1-1 | ACCEPTED. Done-rule per option. |
| 14 | R5 "done" not pass/fail; CSV cannot be visually checked; legacy pairs unstated | Gate P1-4 | ACCEPTED. Per-surface criteria; R5-Q2, Q3. |
| 15 | R3 missing rules for rows that inherited the default currency; implied backfill ungated | Gate P1-5 | ACCEPTED. Census in R0; R3-Q4; explicit "no backfill or migration without separate approval". |
| 16 | R2 missing owner rules (sweep as only trigger, partial refund, cancel after recognition, retry, where the flag shows) | Gate P2-2 | ACCEPTED. R2-Q3 to Q7; sweep noted. |
| 17 | R4 "same message" ambiguous; no exit for refused draft; non-rupee rule | Gate P2-5 | ACCEPTED. R4-Q2, Q3; validation text named. |
| 18 | R3 scope loose; existing "Mixed currencies" precedent omitted | Gate P2-6 | ACCEPTED. |
| 19 | Gates G-C/D/E bind nothing | Gate P2-7, Reader | ACCEPTED. "Blocks" column added. |
| 20 | Undefined terms, code names in owner questions, several names for one thing, no recommendations or consequences | Reader §1–3 | ACCEPTED in the main: terms section extended, "counted" used throughout, questions reworded with consequence and recommendation. Function and file names remain where an implementer needs them. |
| 21 | "Failing tests first" does not fit a data correction | Gate P2-4 | ACCEPTED. Verification route stated under R1. |
| 22 | `AGENTS.md` is stale (says two migrations exist only on another branch; both are in this checkout), so it is weak evidence for G-C | Gate P3 | ACCEPTED. Stated in G-C. |

No finding rejected.

## Decision check (TypeSafe Jev), 15 Nov 2026

Called by REST (`POST /v1/systemone`, model reported `jev-1.14.0`); the `typesafe` MCP server failed to start in this session.

- Order of work: `COUNT_THEN_TWO_ROUTES_THEN_OLD_DATA` 0.99, `COUNT_THEN_OLD_DATA_THEN_TWO_ROUTES` 0.01, `OLD_DATA_FIRST_WITHOUT_COUNT` 0.00. Band: act.
- Count before choosing a correction rule: 0.89. Band: act.

The input described the situation in general terms only; no names, amounts or identifiers were sent.

## Round 2 — 15 Nov 2026, Implementation Gate on rev 2

Verdict: **BLOCK** (2 × P1, both in R1; one contradiction with the repository in R0). All 22 round-1 findings confirmed addressed, two only in part.

| # | Finding | Disposition in rev 3 |
|---|---|---|
| P1-1 | No way to invoke any R1 option exists: the only caller of the reversal function is the booking-cancellation sync. "Through the application" needs a new, tested entry point. | ACCEPTED. Stated under "Rules common to A, B, C and E"; R1-Q7 added; verification split into code route (entry point) and data route (write run). |
| P1-2 | Option E misdescribed: it edits the legacy counter-entry's memo (even in a closed period, no version bump), has no target check, cannot be undone, and leaves the pair matching the R0 search. | ACCEPTED. E row rewritten with these facts; target restricted to the saved R0 list; "corrected" defined per option; R1-Q8 (undo) added; recommendation changed from "E" to "B or E". |
| P2-1 | R0 asserted the `public` schema; migration notes say `booklets`. | ACCEPTED. Now "the schema production actually uses, confirmed under G-C". |
| P2-2 | "Per currency" basis and B's line currency unstated. | ACCEPTED. Currency is the one the R3-Q3 answer assigns. |
| P2-3 | R2 done-rule assumes the recommended answers; missing the no-pre-payment case. | ACCEPTED. Made conditional; case added. |
| P3-1 | R5 done-rule assumes "labels". | ACCEPTED. |
| P3-2 | What the later sweep becomes. | ACCEPTED. R2-Q8. |
| P3-3 | "Same validation text" loose. | ACCEPTED. "Contains". |

Also folded in from the drift check (documents reviewer, P3): G-B now notes the failing `npm audit` step and the outstanding DeepSeek review; G-D notes the period end-date-at-midnight point; R3-Q5 asks whether the unused `getAccountBalance` may be removed; section 5 lists the remaining small residuals.

## Round 3 — 15 Nov 2026, Implementation Gate on rev 3

Verdict: **BLOCK**, narrowly: all eight round-2 findings confirmed fixed and the option E row confirmed accurate against the code; one new contradiction in the R1 done-rule.

| # | Finding | Disposition in rev 4 |
|---|---|---|
| N1 | R1 done-rule required every saved-list pair to be corrected while also allowing pairs to be left alone. | ACCEPTED. Now "every pair the owner approved for correction"; the rest on a signed left-alone list. |
| N2 | Option A has no rule for a pair whose two sides are in different currencies. | ACCEPTED. R1-Q9. |
| N3 | "Re-run of the R0 inventory" cannot show the criterion; "saved list" ambiguous. | ACCEPTED. "Verification pass over the saved list (the run immediately before the write)"; content left to the R1 test plan. |
| N4 | R3 done-rule not conditioned on R3-Q2. | ACCEPTED. |
| N5 | R3-Q3 wording clashes with "stored lines always carry a currency". | ACCEPTED. Reworded. |

## Round 4 — 15 Nov 2026, Implementation Gate on rev 4

Verdict: **PASS** — "fit to put to the owner for sequencing and the first answers". N1–N5 confirmed fixed. Five P3 tidy-ups (F1–F5: leftover wording in R1 and section 6, option C scoping, the Jev figure, question order) applied after the verdict; they change no rule.

This PASS covers the roadmap as a document to put to the owner. It authorises no item. Each of R1–R5 needs its own plan, reviews and owner sign-off. Not an independent human review.
