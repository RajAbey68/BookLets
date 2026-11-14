# TEST PLAN — ledger reversal and mixed-currency repair

Test plan reviewed before any test or code is written (the EGM gate: three independent zero-context reviews, then owner sign-off). This is a code fix only; no stored data is read or corrected. The investigation that established the two defects is `EVIDENCE.md` in this folder; the original owner questions are in `RESUME.md` and their answers in `SIGNOFF.md`. Baseline commit `bc2147734bc5ae792f0b451394e7875d3074cb46`. No test or source code is written until this plan passes review.

Location note: the EGM skill places plans under `docs/designs/`. The governing assignment only permits run artifacts under `docs/runs/`, so the plan lives here.

## 1. Scope

Files that may change: `src/lib/ledger.service.ts`, unit tests under `tests/unit/`. Nothing else.

Must not change: prisma schema and migrations, server actions, auth and role logic, display formatting, `src/lib/books-view.ts` (see section 7), report files, configuration.

## 2. Definitions

- **Entry**: a `JournalEntry` row with `status` one of `DRAFT`, `POSTED`, `VOIDED`, plus its `JournalLine` rows.
- **Line**: `{ accountId, amount (positive decimal), isDebit, currency }`. Sign is carried by `isDebit`.
- **Counted**: every report and balance in the app reads lines of `POSTED` entries only. `DRAFT` and `VOIDED` entries are not counted.
- **Original**: the entry passed to `LedgerService.reverseEntry`.
- **Counter-entry**: the new entry `reverseEntry` creates.
- **Denomination of an input line**: its `currency` string exactly as given, or the marker *unspecified* when `currency` is `undefined` (the input type is `string | undefined`). No case folding, no trimming.
- **Uniform**: all lines of a set have the same denomination.

## 3. Decisions under test

All six decisions were confirmed by the owner on 14 Nov 2026; the answers are recorded in `SIGNOFF.md`.

- **D1 — Reversal nets to zero by keeping the original counted.** `reverseEntry` creates a counted counter-entry and leaves the original `POSTED`. It no longer sets the original to `VOIDED`. Worked example for an original of +1250 on cash: today, voiding removes the +1250 from the counted set and the counter-entry adds −1250, so cash shows −1250; after the fix both are counted and cash shows 0. Keeping the original preserves the closed-period figures it was posted into (FRD N-01 "Zero deletions. Reversals only.").
- **D2 — An original can be reversed once; a repeat call returns the existing counter-entry.** Because the original stays `POSTED`, the `VOIDED` status no longer stops a second reversal. The counter-entry therefore carries `source = 'reversal'`, `sourceId = <original id>` and `idempotencyKey = computeIdempotencyKey('reversal', <original id>, <original's date>, { organizationId })` with no `operation`. The original's date is used, not "now", so the key is the same on any day; there is no fallback when the date is missing. Before writing anything, `reverseEntry` looks for an existing counter-entry (`findFirst` on the same client as the original lookup, `where: { organizationId, source: 'reversal', sourceId: <original id> }`). If one exists, `reverseEntry` resolves to it and writes nothing: no new entry, no memo update, no evidence record, no fiscal-period check. If two calls race, the `(organizationId, idempotencyKey)` unique index rejects the loser's insert (Prisma `P2002`); the loser then repeats the lookup and resolves to the winner's counter-entry, or rethrows the `P2002` if the lookup finds nothing.
- **D3 — A counter-entry cannot itself be reversed.** An entry whose `source` is `'reversal'` is refused. To undo a reversal, post a fresh entry. Counter-entries created before this fix have no `source` and are not recognised; they are out of scope.
- **D4 — The counter-entry copies each line's currency** from the original line, verbatim. `reverseEntry` does not apply D5: an old original that is itself mixed is mirrored exactly, because only an exact mirror nets to zero in each currency.
- **D5 — `validateTrialBalance` rejects a non-uniform line set**, so `postEntry` with status `POSTED` refuses it. No conversion, no per-currency subtotals. This is a check on that write path, not a guarantee about stored data: drafts are not validated, and draft approval does not pass currency (section 7). An entry that is uniformly a non-books currency (all EUR) is still accepted. A line set that mixes a stated currency with omitted ones is refused even though the schema default is `LKR`, because the production column default is recorded as still `EUR` (`src/lib/money-format.ts`), so an omitted currency is not reliably the books' currency. No current caller mixes stated and omitted lines: the importers state it on every line; booking and receipt paths omit it on every line.
- **D6 — The counter-entry is dated today and today must be in an open fiscal period.** After the repeat-call lookup and before any write, `reverseEntry` calls the existing `LedgerService.checkFiscalPeriod(organizationId, <now>)`. Its three existing refusals apply unchanged: no period defined for the date, period closed, period locked. The original's own period is not checked and not touched.
Check order in `reverseEntry`: original not found; original not `POSTED`; original is a counter-entry (D3); existing counter-entry found, return it (D2); today's period not open (D6); then the transaction.

Unchanged on purpose: the original's memo still gets ` | Reversed by <id>` appended; evidence event `JOURNAL_REVERSED`; tenant-scoped lookup; only `POSTED` entries are reversible; the counter-entry's own memo text; the evidence payload. These are unchanged but not all pinned by tests.

## 4. Acceptance criteria — reversal

Fixture F1 (synthetic): original `je-1`, org `org-1`, `POSTED`, date `2026-06-01T00:00:00Z`, `source: 'booking'`, `sourceId: 'bk-1'`, memo `'Initial Booking Funds: #HW-1'`, lines `[ {acc-cash, 1250.00, debit, LKR}, {acc-deferred, 1250.00, credit, LKR} ]`.

Test seam: `src/lib/prisma` and `src/lib/evidence-log.service` are mocked with `vi.doMock`, as in the existing `tests/unit/journal-reverse-entry.test.ts`. New reversal tests go in that same file.

Harness changes to that file (no assertion is changed by them):

- The shared fixture `originalEntry` becomes F1: it gains `date: new Date('2026-06-01T00:00:00Z')` (a `Date`), `source: 'booking'`, `sourceId: 'bk-1'`, and `currency: 'LKR'` on both lines.
- `mockDeps(findFirstResult, existingReversal = null, period = OPEN_PERIOD)`: the single `prisma.journalEntry.findFirst` mock becomes an implementation that resolves `existingReversal` when its argument's `where.source === 'reversal'` (if `existingReversal` is an array, one element is consumed per such call and the last element repeats), and `findFirstResult` otherwise. The prisma mock gains `fiscalPeriod: { findFirst: periodFindFirst }` resolving `period`, where `OPEN_PERIOD = { name: 'FY2026', isClosed: false, locked: false }`. `periodFindFirst` is returned alongside the existing handles. A test may override `create` to reject. The file imports `Prisma` from `@prisma/client` to build the `P2002` error, as `tests/unit/journal-idempotency.test.ts` does.
- The transaction client mock is unchanged (`create`, `update`).

| ID | Given | When | Then |
|---|---|---|---|
| R-1 | F1; no counter-entry exists | `reverseEntry('org-1','je-1','reason','user-1')` | `journalEntry.update` is called exactly once, with `where: { id: 'je-1' }`, and its `data` has **no** `status` key |
| R-2 | as R-1 | same | `update` `data.memo` equals `'Initial Booking Funds: #HW-1 | Reversed by je-rev'` (pins existing behaviour) |
| R-3 | as R-1 | same | Counted net-zero. Compute: original's resulting status = `update` call's `data.status` if that key is present, else the fixture status; counter-entry's status = `create` call's `data.status`. Sum (debit +, credit −) only the lines of entries whose resulting status is `'POSTED'`. Result is exactly `0` for `acc-cash` and `0` for `acc-deferred`. On the unfixed tree this yields −1250 and +1250 |
| R-4 | as R-1 | same | `create` is called once; `data.status === 'POSTED'`; lines are `[ {acc-cash, credit, '1250'}, {acc-deferred, debit, '1250'} ]` in the original's line order (currency is asserted by R-5 only) |
| R-5a | F1 (both lines `'LKR'`) | same | each created line's `currency` strictly equals `'LKR'` (copied, not defaulted) |
| R-5b | F1 with both line currencies `'EUR'` | same | each created line's `currency` strictly equals `'EUR'` |
| R-6 | as R-1 | same | `create` `data.source === 'reversal'`, `data.sourceId === 'je-1'`, and `data.idempotencyKey === LedgerService.computeIdempotencyKey('reversal', 'je-1', new Date('2026-06-01T00:00:00Z'), { organizationId: 'org-1' })` |
| R-7 | F1; `existingReversal = { id: 'je-rev-0' }` | same | resolves to an object whose `id` is `'je-rev-0'`; `create`, `update`, evidence `record` and `periodFindFirst` are not called |
| R-8 | F1 with `source: 'reversal'`, `sourceId: 'je-0'` | same | rejects with an error matching `/reversal entr(y|ies) cannot be reversed/i`; no `create`, no `update` |
| R-9 | as R-1 | same | `findFirst` is called with an argument whose `where` equals `{ organizationId: 'org-1', source: 'reversal', sourceId: 'je-1' }`, and that call's `mock.invocationCallOrder` is lower than `create.mock.invocationCallOrder[0]` |
| R-10 | F1; `create` rejects with a `Prisma.PrismaClientKnownRequestError` of code `P2002` whose `meta.target` is `['organizationId','idempotencyKey']`; `existingReversal = [null, { id: 'je-rev-0' }]` (a concurrent reversal won the race) | same | resolves to an object whose `id` is `'je-rev-0'`; `update` not called; evidence `record` not called |
| R-11 | F1; `create` rejects with a plain `Error('db down')` | same | rejects with that same error unchanged |
| R-12 | F1; `period = { name: 'FY2026', isClosed: true, locked: false }` | same | rejects with an error matching `/closed/i`; `create` and `update` not called |
| R-13 | F1; `period = { name: 'FY2026', isClosed: false, locked: true }` | same | rejects with an error matching `/locked/i`; `create` and `update` not called |
| R-14 | F1; `period = null` | same | rejects with an error matching `/No fiscal period defined/`; `create` and `update` not called |
| R-15 | as R-1 | same | `periodFindFirst` is called once, before `create` (by `invocationCallOrder`); its argument's `where.organizationId === 'org-1'`; `where.startDate.lte` and `where.endDate.gte` are the same instant (`getTime()`) as the `create` call's `data.date`; and that `data.date` is a `Date` within 5 seconds of the test's clock |
| R-16 | F1 with line currencies `'EUR'` (acc-cash) and `'LKR'` (acc-deferred) | same | resolves; `create` is called once; created line currencies are `'EUR'` then `'LKR'`, in the original's order (D4: mirrored, D5 not applied) |

Existing tests in `tests/unit/journal-reverse-entry.test.ts` and their fate:

| Existing test | Fate |
|---|---|
| scopes the entry lookup by organizationId | kept unchanged |
| rejects with "not found" for another organization | kept unchanged |
| rejects reversal of a non-POSTED entry | kept unchanged |
| creates reversal lines with flipped isDebit and identical amounts | kept unchanged |
| **marks the original entry VOIDED** | **replaced** by R-1/R-2. This assertion encodes the defect: it pins the write that removes the original from the counted set while the counter-entry stays counted. Old and new assertion are shown verbatim in the diff and flagged for the independent reviewer |


## 5. Acceptance criteria — currency

`validateTrialBalance(lines)` — pure, no mocks.

| ID | Lines | Then |
|---|---|---|
| C-1 | `[ {100, debit, 'EUR'}, {100, credit, 'LKR'} ]` | `isValid === false`; `error` matches `/mixed currenc/i`, contains `'EUR'` and contains `'LKR'` |
| C-2 | `[ {100, debit, 'LKR'}, {100, credit, currency omitted} ]` | `isValid === false`; `error` matches `/mixed currenc/i` |
| C-3 | `[ {100, debit, 'LKR'}, {100, credit, 'LKR'} ]` | `isValid === true`; `balance` is zero (same as before the fix) |
| C-4 | `[ {100, debit}, {100, credit} ]`, no currency anywhere | `isValid === true` (same as before the fix) |
| C-5 | `[ {100, debit, 'LKR'}, {60, credit, 'LKR'} ]` | `isValid === false`; `error` matches `/unbalanced/i`, not `/mixed/i` (same as before the fix) |
| C-6 | `[ {100, debit, 'LKR'}, {100, credit, 'lkr'} ]` | `isValid === false`, `/mixed currenc/i` (exact string comparison) |
| C-7 | one line only, any currency | `error` is the existing "at least two lines" message (check order: line count, then denomination, then balance) |

For a non-uniform set the returned `balance` is `Decimal(0)`; tests do not assert on it, because a raw cross-currency difference is not a money figure.

Before/after proof for single-currency behaviour: the eight existing `validateTrialBalance` tests in `tests/unit/ledger-service.test.ts` are not edited and must pass before and after.

`postEntry` — mocked prisma, as in `tests/unit/journal-idempotency.test.ts`.

| ID | Given | Then |
|---|---|---|
| C-8 | `status: POSTED`, lines as C-1 | rejects with `/CRITICAL LEDGER ERROR/` and `/mixed currenc/i`; `prisma.$transaction` not called; `prisma.fiscalPeriod.findFirst` not called |

Test files: R-1 to R-16 in `tests/unit/journal-reverse-entry.test.ts`; C-1 to C-7 in `tests/unit/ledger-service.test.ts`; C-8 in `tests/unit/journal-idempotency.test.ts`. One `it` per ID, with the ID at the start of the test title. That is 17 reversal tests (R-1 to R-16, with R-5 as R-5a and R-5b) and 8 currency tests (C-1 to C-8): 25 new tests. Comment edits in those files are allowed where the old comment describes the replaced behaviour.

## 6. Red and green expectations

Command for both: `npm run test:unit`.

Baseline on the untouched tree (EVIDENCE.md step 7): 65 files passed, 974 tests passed, 0 failed, 0 skipped, 1 unhandled error originating in `tests/unit/ingest-item-route.test.ts`, exit code 1.

- Red (new tests added, source unfixed): fail R-1, R-3, R-5a, R-5b, R-6, R-7, R-8, R-9, R-10, R-12, R-13, R-14, R-15, R-16, C-1, C-2, C-6, C-8. Pass R-2, R-4, R-11, C-3, C-4, C-5, C-7 (they pin behaviour that must not change). The four kept existing reversal tests pass; the replaced one is gone. No other existing test fails.
- Green (source fixed): zero failed tests; zero skipped; every new test passes; total passed is exactly 998 (974 − 1 replaced + 25 new); exactly one unhandled error and it originates in `tests/unit/ingest-item-route.test.ts`; exit code 1 for that reason alone. Any other error, any failure, or any skip is NOT green.

No test may be skipped, deleted or loosened to reach green, other than the one replacement named in section 4.

## 7. Explicitly not covered

- `LedgerService.getAccountBalance`: it adds an account's counted lines without reading currency. It has no caller in `src/`. An account can properly hold lines from single-currency entries in different currencies, so refusing to return a balance would need a rule the owner has not set. Left unchanged.
- Entries already reversed under the old behaviour (original `VOIDED`, counter-entry counted) stay wrong until corrected as a separate, owner-approved data task.
- `toBookRow` (`src/lib/books-view.ts`): a mixed-currency row total needs a new field on `BookRow` or a page change; both are outside the permitted scope.
- Report totals (`trial-balance-report.ts`, `balance-sheet-report.ts`, `pl-statement-report.ts`, `metrics.service.ts`): they never read `currency`; outside scope.
- Draft approval (`approval.actions.ts`) strips `currency` before calling `validateTrialBalance`, so D5 does not bind there; it is a server action and outside scope.
- `DRAFT` entries are not validated by `postEntry` today and are not after the fix.
- Existing rows whose currency was inherited from a column default. No data is read or rewritten.
- Database-level behaviour (unique index, triggers): unit tests mock prisma. The `(organizationId, idempotencyKey)` unique index is the concurrency backstop for D2 and is not exercised here.
- Callers of `reverseEntry` (`revenue.service.ts`): its lookup takes the newest `POSTED` entry for a booking; after D1 a second cancellation of the same booking finds the already-reversed original; `reverseEntry` returns the existing counter-entry and the caller goes on to clear `deferredPosted`. Not changed.

## 8. Visual checks

None. No UI file, route or rendered output changes. Jev Vision typed visual acceptance does not apply.

## 9. Rollback

Reverting the fix commit restores the old code. It is data-neutral only if no reversal ran under the new code. Any original reversed while the fix was live is still `POSTED` with a counted counter-entry; the old code would treat it as reversible and reverse it a second time. Before reverting, list those pairs (counter-entries have `source = 'reversal'`, `sourceId` = the original's id) and handle them as an owner-approved data task. No schema or configuration change accompanies the fix.

## 10. Known residuals raised by review (not fixed here, owner-visible)

- Booking cancellation has two independent reversal routes in `revenue.service.ts` (`handleBookingCancellation` via `reverseEntry`, and `postCancellationReversal`) with no shared idempotency. If the first succeeds but the following `booking.update` fails, a later sync can post a second reversing entry through the other route, leaving the books at minus the amount. Outside the permitted files.
- The `postEntry` idempotency fast path returns an existing entry whatever its status, including one already reversed (same-day cancel, reinstate, cancel).
- The memo append on the original is an unguarded write (no version check); under D1 the original stays editable, so a concurrent memo edit can be overwritten.
- If a counter-entry later stops being counted, D2 and D3 together leave the original impossible to reverse again.
- The original lookup and status check run before the transaction opens (unchanged).
