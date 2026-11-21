# Ledger residuals — roadmap and owner rule questions

Status: DRAFT rev 4, 15 Nov 2026, revised after three rounds of zero-context review (see `REVIEW-LOG.md` beside this file). Nothing here is to be executed. This document orders the work left over from the ledger repair and lists the decisions the owner must make before each item can start. No production read, write, migration or backfill happens under any item without its own explicit owner approval.

Branch: `docs/ledger-residuals-roadmap` (local only; it sits on top of the repair branch and does not move it).

## 1. Terms

- **The repair**: the change under review as pull request 181 on GitHub (branch head `982e8e2`). It makes a cancelled journal entry net to zero and refuses a single journal entry whose lines are in different currencies. It is not merged and not deployed.
- **Counted**: a journal entry with status `POSTED`. Every report adds counted entries only. This document says "counted" throughout.
- **Voided**: status `VOIDED`. Not counted. A rejected draft also ends up voided, so "voided" alone does not mean "reversed". Voided entries are not protected from deletion by the database (the delete guard covers counted entries only).
- **Original**: a journal entry that was later reversed.
- **Counter-entry**: the entry that mirrors an original with debit and credit swapped.
- **Correcting entry**: a new entry posted to repair a wrong pair. Not the same thing as a counter-entry.
- **Legacy pair**: an original and counter-entry made by the code before the repair. The original was set to voided; the counter-entry is counted, has memo starting `AUTO-REVERSAL: [Original Entry ID: <id>]`, has no link fields, and its lines took the database's default currency instead of the original's. Books show **minus** the original instead of zero.
- **New pair**: made by the repair's code. Original stays counted; counter-entry is counted, linked to the original (`source='reversal'`, `sourceId=<original id>`) and copies each line's currency. Net zero. This is owner decision D1 ("keep the original, add a counter-entry") from the repair's sign-off.
- **Link fields**: `source` and `sourceId` on a journal entry, recording what created it (for example a booking and its id).
- **Pre-payment entry**: the entry posted when a booking is confirmed (cash received, liability to the guest). The booking then carries the flag `deferredPosted = true`.
- **Sync**: the job that pulls bookings from Hostaway and posts or cancels pre-payment entries.
- **Route one / route two**: the two places in the sync that cancel a pre-payment (section 3, R2).
- **Closed period**: a fiscal period marked closed or locked; the database refuses new entries dated inside it. This document treats closed and locked the same.
- **Production**: the live database and deployed app.
- **Held permissions work**: a separate, unpublished 35-file change to approvals and roles that the owner is holding. It edits some of the same files; this roadmap must not duplicate or collide with it.
- **Organisation**: the tenant that owns a set of books (for these books, the villa business).

## 2. Gates

| Gate | What it means | State | Blocks |
|---|---|---|---|
| G-A | An independent person reviews the repair | Owner posted a written reviewer sign-off on PR 181 (15 Nov); GitHub records no formal review | Merging the repair |
| G-B | The repair is merged | **Done.** Merged by the owner 15 Nov 2026, 17:44 UTC (`f757d8a`). Still open: `Build & Lint` fails at the `npm audit` step, and the DeepSeek review never ran (blocked by the owner's OpenRouter guardrail). | G-F |
| G-C | Production has the pieces the repair relies on: the unique index on organisation plus idempotency key, and the link-field columns. Also that the loose trigger file `20260812_0001_pr_151_triggers.sql` has **not** been applied (it would reject every counted entry). | Evidence from the repository only (migrations `20260701_journal_idempotency_key`, `20260703_journal_source_fields`). `AGENTS.md` says production is applied through `20260703_*`, but that file is stale in other respects, so this is weak evidence. **Pass — checked against production 17 Nov 2026** (read-only queries, see section 2a). | Deploying the repair |
| G-D | An open fiscal period covers today. A continuing condition, not a one-off: after the repair, a cancellation is refused on any day no open period covers. | **Pass on 17 Nov 2026**: one open, unlocked period covers today (48 periods in total). Note: a period whose end date is stored as midnight at the start of its last day does not cover that last day. | Deploying the repair; every later item that posts an entry |
| G-E | The sandbox duplicate-import guard is in place before any imported payment is promoted into the journal (`AGENTS.md`). | Not applied to production | Importing; not R0–R5 directly. Whether it also blocks correcting entries (R1) is owner question R1-Q6. |
| G-F | The repair is **deployed to production** and the deployed commit is confirmed | **Done.** Vercel deployed `f757d8a`, then `6a604ae`, to Production on 15 Nov 2026 (GitHub deployments record) | R0 (final run), R1, R2, R4, R5 |

G-C and G-D each need a look at production. Who looks is owner question R0-Q1 (same answer applies).

### 2a. Production check — 17 Nov 2026 (read-only)

SELECT-only queries on the production Supabase project, run by an AI agent through the owner's signed-in Supabase CLI on the owner's instruction. Counts only; no ledger amounts or text were copied out. Nothing was written.

| Check | Result |
|---|---|
| `JournalEntry.idempotencyKey`, `source`, `sourceId` columns | Present |
| Unique index `JournalEntry_organizationId_idempotencyKey_key` | Present, unique |
| Triggers on `JournalEntry` | Only `journal_entry_fiscal_lock` and `journal_entry_no_posted_delete`. No balance-validation trigger, so `20260812_0001_pr_151_triggers.sql` is not applied |
| Migrations `20260701_journal_idempotency_key`, `20260703_journal_source_fields`, `20260703_fiscal_lock_and_posted_delete_triggers` | Applied, not rolled back |
| Fiscal-lock trigger on a memo-only update | Allowed (it only checks when the date or organisation changes), so marking a reversed original works in a closed period |
| `JournalLine.currency` default | Still `'EUR'` (`20260802_currency_default_lkr` not applied) |
| Line currencies | All 786 lines are `LKR`; none blank, none `EUR` |
| Journal activity | Newest entry created 4 Aug 2026, last update 4 Aug 2026. Nothing written since the 15 Nov deploy. Totals: 375 DRAFT, 16 POSTED, 2 VOIDED |
| Legacy reversal pairs (pre-fix pattern: `AUTO-REVERSAL:` counter-entry, original VOIDED with `Reversed by`) | 0 counter-entries, 0 such originals. The 2 VOIDED entries are not reversals |
| Production application logs (Vercel) since 15 Nov | **Not checked** — no Vercel access from the session |

Consequences: R1 (correct legacy pairs) has nothing to correct today. The repair has not yet run against production data. The `EUR` default matters only for future lines written without a currency.

Why G-F matters: until the repair is live, every booking cancellation in production keeps creating legacy pairs. A count taken before deployment goes stale.

## 3. Items

### R0 — Inventory (read-only)

Purpose: find out what wrong data exists before choosing any correction. Production may hold little or none (`AGENTS.md`: properties are intentionally empty and imports are gated), but that is an expectation, not a measurement.

The inventory returns, per organisation:

1. **Legacy pairs**: counted entries whose memo starts `AUTO-REVERSAL: [Original Entry ID:` with no link fields, each with the original it names, the original's status, and the currency of every line on both sides. Cross-checked against the app's evidence log (`JOURNAL_REVERSED` records), because memo text can be edited.
2. **Route-two cancellations**: counted entries whose memo starts `Cancellation Reversal: Refund for Booking #`. These leave the original counted, so on their own they already balance and must not be "corrected".
3. **Bookings with both** a route-one and a route-two cancellation: possible double cancellations, decided one by one.
4. **Bookings currently cancelled with `deferredPosted = true`**: these will be cancelled by the next sync.
5. **Currency census**: how many journal lines exist per currency code. Needed for R3.
6. Anything that does not fit: a memo whose id cannot be read, an id that matches no entry, an original that is not voided. Listed, not guessed at.

Handling: no query is written here. Each query is written against the schema production actually uses (the repository's own notes disagree between `public` and `booklets`; confirmed as part of the G-C check), checked against the exported schema notes the owner keeps for this database, and shown to the owner before it runs. The output is real ledger data: it is given to the owner and is **not** committed to the repository.

Timing: a first run may happen before G-F to size the problem. The run that R1 relies on happens after G-F.

Owner questions:

- **R0-Q1** May read-only queries be run against production, and who runs them? Either the owner runs queries that are handed over, or an AI agent runs them with a read-only credential the owner supplies. A read-only credential cannot change data. The same answer covers the G-C and G-D checks.

Done when: the owner holds the six lists above for each organisation, produced after G-F.

### R1 — Correct the legacy pairs

Only if R0 finds any. This changes or adds real ledger records, so it has the highest risk of any item.

Options, per legacy pair:

| | What is done | Past periods' totals | Risks and notes |
|---|---|---|---|
| **A** | Set the original back to counted, and give the counter-entry link fields so the original cannot be reversed twice | Change (the past becomes right) | Edits historical records. The database allows it even in a closed period, because a status-only change is not re-checked. Line currencies on the counter-entry may still differ from the original's. After the change, the pair no longer matches the R0 search, so checking uses the saved R0 list. |
| **B** | Post a new correcting entry dated today that repeats the original's lines, in the currency the R3-Q3 answer assigns to the legacy counter-entry's lines | Stay wrong for the old period; put right in the current one | Nothing historical is edited. The correcting entry must carry its own link (`source='correction'`, `sourceId=<original id>`) and an idempotency key, never the booking link, or a later cancellation would pick it up; without a key, re-running would correct twice. The voided original stays unprotected from deletion. |
| **C** | Set the counter-entry to voided | Change | Both halves leave the counted trail and both become deletable. Opposite of decision D1. Not recommended. |
| **D** | Leave as is, record the known error | Stay wrong | No write. |
| **E** | Reverse the legacy counter-entry using the repair's own reversal function | Stay wrong for the old period; put right in the current one | The function itself is tested and once-only per entry. It posts a counted entry dated today, linked to the legacy counter-entry (`source='reversal'`, `sourceId=<counter-entry id>`), whose lines copy the counter-entry's stored currency. It also **edits one historical record**: it appends ` \| Reversed by <id>` to the legacy counter-entry's memo, even in a closed period, without a version bump. Its memo and evidence record name the counter-entry as the "original", not the true original. It has **no target check**: run on the wrong entry (a route-two entry, a pair whose original is not voided, a mistyped id) it creates new wrong data. Its result **cannot be reversed** (a reversal entry is refused), so a mistake needs a hand-built correcting entry. The voided original stays voided and unprotected from deletion. |

Rules common to A, B, C and E:

- **None of them can be run today.** The only thing that calls the reversal function is the booking-cancellation sync; no screen, action or script reverses or edits an arbitrary entry. Any option done "through the application" needs a new entry point (who may run it, under whose name, with what reason text), built as its own code change with a test plan, reviews, sign-off and failing tests first, like R2–R5.
- **They apply only to ids on the saved R0 list** (list 1) whose original is voided. Nothing from lists 2, 3 or 6 is touched without an individual owner decision.
- **"Corrected" is defined per option**, because under B and E the legacy counter-entry still matches the R0 search afterwards: A — the original is counted and the counter-entry has link fields; B — a counted entry exists with `source='correction'`, `sourceId=<original id>`; E — a counted entry exists with `source='reversal'`, `sourceId=<counter-entry id>`; C — the counter-entry is voided.

Recommendation (not a decision): **B or E** if anything from the affected periods has been issued to anyone, **A** if not. B needs more new code than E but names the true original and edits nothing historical.

Owner questions:

- **R1-Q1** Which option?
- **R1-Q2** Have any statements, owner reports or tax filings been issued from the periods the legacy pairs sit in? If yes, changing past totals (A, C) contradicts what was issued; B or E keeps the past as issued.
- **R1-Q3** If a pair sits in a closed period, is A or C still allowed there, or must it fall back to B or E?
- **R1-Q4** Must the write go through the application (which adds a tamper-evident evidence record and bumps the entry's version), or is a direct database change acceptable? Recommendation: through the application.
- **R1-Q5** Is a backup with a tested restore required before the write? Recommendation: yes. Who performs the write, and is each pair approved individually or the list as a batch?
- **R1-Q6** Does gate G-E (duplicate-import guard) also have to be in place before correcting entries are posted?
- **R1-Q7** Should the entry point be a one-off script that is removed afterwards, or a permanent "correct this entry" action in the app, and who may run it?
- **R1-Q8** If a correction is itself applied to the wrong entry, how is it undone: by a further hand-approved correcting entry (the only route available under E), or must the chosen option be reversible by design?
- **R1-Q9** Under option A, if the two sides of a pair are in different currencies once the R3-Q3 rule is applied, does that pair fall back to B or E, or may the counter-entry's line currency be edited (a further historical edit)?

Prerequisites: R3-Q1 and R3-Q3 answered (the rule only), because "nets to zero" needs to know what currency a line is in.

How it is verified: two parts. The entry point is code and follows the code route (test plan, reviews, sign-off, failing tests first). The write run itself is a data correction: a dry run on a copy of the data, a backup, the write, then the verification pass over the saved list (see "Done when").

Done when, by option:
- A, B, E: a verification pass over the saved list (the inventory run made immediately before the write; the content of the pass is set in the R1 test plan) shows, **for every pair the owner approved for correction**, that the pair is "corrected" as defined above and that the counted lines of original, counter-entry and any correcting entry add to zero **per account and per currency, the currency of a line being the one the R3-Q3 answer assigns**. Every other pair on the saved list is on a list the owner has signed as left alone. A record names who approved and who wrote each change.
- C: for every pair the owner approved, both halves voided; every other pair on the signed left-alone list; same record.
- D: a signed note of the known error with the saved pair list.

### R2 — One cancellation route for bookings

Today, in one run of the sync:

- **Route one** runs first for each cancelled booking that has `deferredPosted = true`. It looks for the newest counted pre-payment entry linked to the booking and reverses it with the ledger's reversal function (the one the repair fixes), then sets `deferredPosted = false`. If it finds no such entry it writes an error to the server log and leaves the flag set.
- **Route two** runs later **in the same run**, for every cancelled booking whose flag is still set. It builds its own cancelling entry from the booking's current total amount, with no link fields, no idempotency key and no currency, and clears the flag.

So today:

- If route one finds nothing, route two posts a cancelling entry anyway, from the booking amount, minutes later. That amount is overwritten from Hostaway on every sync and may differ from what was originally posted.
- If route one posts its counter-entry and the flag update then fails, route two posts a second cancelling entry in the same run. The books then show minus the amount. This creates new wrong data, which is why R2 ranks ahead of correcting old data.
- Route two is also the only thing that cancels a booking Hostaway has stopped returning.

A related fault in the same flow: a booking cancelled, reinstated and cancelled again on the same day. The reinstatement posts no new pre-payment entry (the ledger returns the earlier one) but sets the flag, so the liability is understated.

Owner questions:

- **R2-Q1** Should a cancellation always go through the ledger's reversal function, so that the amount reversed is exactly the amount originally posted? Recommendation: yes. Consequence: route two no longer invents an entry from the booking amount.
- **R2-Q2** When a cancelled booking has no counted pre-payment entry to reverse, should the system (a) post nothing and raise a visible item for a person to resolve, or (b) build an entry from the booking amount as route two does today? Recommendation: (a). Under (b) the books can receive an entry that mirrors nothing.
- **R2-Q3** If (a): where does the item appear (today it is only a line in the server log), and who clears it? The booking would otherwise be re-flagged on every sync.
- **R2-Q4** Is a cancellation always a full reversal of the pre-payment, or can part be kept (a cancellation fee)? Today both routes assume full.
- **R2-Q5** What should happen when a booking is cancelled after its revenue was already recognised?
- **R2-Q6** When a cancellation is refused because no open period covers today, should the sync simply retry on later runs until one does? Recommendation: yes, with the visible item from R2-Q3.
- **R2-Q7** Should the same-day cancel, reinstate, cancel fault be fixed as part of R2? Recommendation: yes.

- **R2-Q8** The later sweep in the same sync is the only thing that cancels a booking Hostaway has stopped returning, and the only retry. Should it stay as a trigger but call the reversal function instead of building its own entry? Recommendation: yes.

Done when (tests), assuming the recommended answers (R2-Q1 yes, Q2 (a), Q4 full, Q7 yes, Q8 yes); restated in the R2 test plan if the owner answers otherwise:

- Each counted pre-payment entry of a cancelled booking has exactly one counted counter-entry, and no other cancelling entry exists for that booking. This holds (a) when both sync steps run in one sync, and (b) after a failure injected between the ledger write and the booking flag update.
- A cancelled booking with no counted pre-payment entry gets no journal entry and exactly one visible item.
- A booking cancelled, reinstated and cancelled again, on the same day or across days, ends with two pre-payment entries and two counter-entries.

### R3 — Report totals add across currencies

The trial balance, balance sheet, profit and loss, dashboard metrics and account service add line amounts without reading the currency (`trial-balance-report.ts`, `balance-sheet-report.ts`, `pl-statement-report.ts`, `metrics.service.ts`, `account.service.ts`; `books.actions.ts` to be checked). The repair stops one entry mixing currencies; it does not stop two entries in different currencies being added together. The `/books` row total is a smaller case: it is only wrong for a single mixed entry. `getAccountBalance` has the same fault but nothing calls it; removing it is simpler than giving it a currency rule (owner question R3-Q5).

Complication: booking entries are written without a currency and take the database default, which in production is still `EUR` (confirmed 17 Nov 2026; migration `20260802_currency_default_lkr` not applied). No production line has taken that default yet: all 786 lines state `LKR`. A line that inherited `EUR` cannot be told apart from a line that is really in euros. The ledger screen already notes that production holds more than one currency.

Owner questions:

- **R3-Q1** Are the books kept in Sri Lankan rupees only? If yes, should posting refuse any entry not in rupees (today an all-euro entry is accepted)? Consequence of refusing: a payout or expense recorded in another currency is rejected until someone converts it.
- **R3-Q2** If other currencies can exist, what do reports show? (a) withhold the total and say "Mixed currencies", which the ledger screen already does; (b) one total per currency; (c) convert to rupees, which needs a rate source that does not exist yet. Recommendation: (a) now.
- **R3-Q3** What currency is a line that was written without a currency and so took the database default? Recommendation: rupees, since the booking paths are the ones that omit it. This needs the census from R0 to confirm.
- **R3-Q4** If R3-Q3 is "rupees": correct the stored rows (a production backfill), or leave them and relabel when reading? And when is migration `20260802` applied? Either is a separate owner-approved step; neither happens under R3 by default.
- **R3-Q5** May the unused `getAccountBalance` function be removed? Recommendation: yes.

Done when (tests), assuming R3-Q2 is (a) or (b); restated in the R3 test plan if the owner chooses conversion: for each of the trial balance, balance sheet, profit and loss, dashboard metrics and account balances, no displayed figure is a sum of amounts in different currencies, where a line's currency is defined by the R3-Q3 answer.

### R4 — Draft approval skips the currency check

When a draft journal entry is approved, its lines are checked for balance without their currency (`approval.actions.ts`), so the repair's mixed-currency refusal does not apply there. This file is part of the held permissions work.

Owner questions:

- **R4-Q1** Sequence: do this after the held permissions work lands (recommended; avoids two changes to one file), or fold it into that work?
- **R4-Q2** A refused mixed draft cannot have its currency edited today; the only exit is to reject it. Is that acceptable?
- **R4-Q3** Should approval also apply the R3-Q1 rule (refuse non-rupee entries)?

Prerequisite: R3-Q3 answered. Stored lines always carry a currency, so once approval reads it, a draft with one stated-rupee line and one defaulted line would be refused; whether that is right is R3-Q3.

Done when (test): approving a draft whose lines are in different currencies is refused, and the refusal message contains the same validation text as posting (`Journal entry has mixed currencies (…)`).

### R5 — Listings show a reversed entry as two ordinary rows

After the repair, the `/books` and `/ledger` screens and the ledger CSV export list an original and its counter-entry as two counted rows; `/books` shows both as positive amounts. Totals are right; only memo text links the two. As a display change this goes through the design gate before any code: a written spec, three independent reviews, typed visual checks of the rendered screens by the Jev Vision service (or a named person if it is unavailable), and owner sign-off.

Owner questions:

- **R5-Q1** Labels on both rows ("Reversed by …" / "Reversal of …"), or the pair collapsed into one row? Recommendation: labels; collapsing hides a counted entry from the audit trail and cannot apply to the CSV.
- **R5-Q2** On `/books`, should the counter-entry's amount be shown as negative?
- **R5-Q3** Should legacy pairs be labelled too? (Depends on the R1 option; a voided original does not appear on `/books` at all.)

Done when (assuming R5-Q1 is "labels"; whether legacy pairs are included follows R5-Q3; restated in the R5 spec otherwise):
- `/books` and `/ledger`: the original's row shows a reversed marker and the counter-entry's id; the counter-entry's row shows the original's id. Checked by typed visual acceptance on fixed fixtures.
- CSV export: two named columns (`reversedBy`, `reversalOf`) carry the same ids. Checked by a unit test.

## 4. Proposed order

1. G-A, G-B, G-C, G-D, then G-F (review, merge, confirm production, deploy the repair).
2. R0 inventory (a sizing run may come earlier; the run of record is after G-F).
3. R2 single cancellation route. Stops new wrong data.
4. R1 correct legacy pairs, if any; R0 re-run immediately before the write (that run is the "saved list" R1 is checked against).
5. R3 report totals.
6. R4 draft approval, after the held permissions work.
7. R5 listing display.

The decision check (TypeSafe Jev, 15 Nov 2026) scored "inventory, then cancellation route, then old data" at 0.99 (reported confidence 0.98) against the alternatives, and "inventory before choosing a correction rule" at 0.89.

Each of R2 to R5 is its own change with its own test plan, three-reviewer check, owner sign-off, failing tests first, then fix. R1 follows the data-correction route described under R1. None is bundled with another.

## 5. Not covered

- The loose trigger file `prisma/migrations/20260812_0001_pr_151_triggers.sql`: reported; only its non-application is checked (G-C).
- Smaller points recorded in the repair's test plan, section 10 (empty-string currency; memo append without a version check; the fiscal-period check running just before, not inside, the write; an original becoming impossible to reverse again if its counter-entry later stops being counted). They stay recorded there until the owner asks for them.
- Stale statements in the repair's run notes: listed in `DRIFT-CHECK.md` beside this file.
- Anything in the older checkout or the held permissions work.

## 6. What the owner is asked now

Actions that come first and are the owner's:

1. Get the repair reviewed by an independent person and merged (G-A, G-B).
2. Confirm, or let someone confirm, the production facts in G-C and G-D.
3. Deploy the repair (G-F).

Answers that can be given now, deliberately early so work can start as soon as the gates clear:

- **R0-Q1**: may read-only queries run against production, and who runs them.
- **R2-Q1, R2-Q2**: one cancellation route, and what happens when there is nothing to reverse.
- **R3-Q1, R3-Q3**: rupees only, and what currency a line that took the database default is. These feed R1 and R4.

Also asked: is the order in section 4 accepted?

Every other question waits for its item.
