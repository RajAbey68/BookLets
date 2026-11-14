# TEST PLAN — ledger reversal and mixed-currency repair

EGM artifact (TDD mode). Baseline commit `bc2147734bc5ae792f0b451394e7875d3074cb46`. No test or source code is written until this plan passes review.

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
- **Denomination of an input line**: its `currency` string exactly as given, or the marker *unspecified* when `currency` is `undefined`, `null` or `''`. No case folding, no trimming.
- **Uniform**: all lines of a set have the same denomination.

## 3. Decisions under test

Taken by the executor on the owner's instruction "proceed with your recommendations" (14 Nov 2026). Each is REVIEW_PENDING until the owner confirms.

- **D1 — Reversal nets to zero by keeping the original counted.** `reverseEntry` creates a counted counter-entry and leaves the original `POSTED`. It no longer sets the original to `VOIDED`. Reason: with the original voided and the counter-entry counted, the amount is subtracted twice. Keeping the original preserves the closed-period figures it was posted into (FRD N-01 "Zero deletions. Reversals only.").
- **D2 — An original can be reversed once.** Because the original stays `POSTED`, the `VOIDED` status no longer stops a second reversal. The counter-entry therefore carries `source = 'reversal'`, `sourceId = <original id>` and a deterministic `idempotencyKey`; a second attempt is refused.
- **D3 — A counter-entry cannot itself be reversed.** An entry whose `source` is `'reversal'` is refused. To undo a reversal, post a fresh entry.
- **D4 — The counter-entry copies each line's currency** from the original line.
- **D5 — A POSTED entry must be uniform in denomination.** `validateTrialBalance` rejects a non-uniform line set. No conversion, no per-currency subtotals.
- **D6 — An account balance is only returned for a uniform set.** `getAccountBalance` throws when the account's counted lines carry more than one currency.

Unchanged on purpose: counter-entry date is "now" and no fiscal-period check is added (the trigger migration calls that "a separate policy decision"); the original's memo still gets ` | Reversed by <id>` appended; evidence event `JOURNAL_REVERSED`; tenant-scoped lookup; only `POSTED` entries are reversible.

## 4. Acceptance criteria — reversal

Fixture F1 (synthetic): original `je-1`, org `org-1`, `POSTED`, date `2026-06-01T00:00:00Z`, `source: 'booking'`, `sourceId: 'bk-1'`, memo `'Initial Booking Funds: #HW-1'`, lines `[ {acc-cash, 1250.00, debit, LKR}, {acc-deferred, 1250.00, credit, LKR} ]`.

Test seam: `src/lib/prisma` and `src/lib/evidence-log.service` are mocked with `vi.doMock`, as in the existing `tests/unit/journal-reverse-entry.test.ts`. The transaction client mock exposes `journalEntry.findFirst`, `journalEntry.create`, `journalEntry.update`.

| ID | Given | When | Then |
|---|---|---|---|
| R-1 | F1; no counter-entry exists | `reverseEntry('org-1','je-1','reason','user-1')` | `journalEntry.update` is called exactly once, with `where: { id: 'je-1' }`, and its `data` has **no** `status` key |
| R-2 | as R-1 | same | `update` `data.memo` equals `'Initial Booking Funds: #HW-1 | Reversed by je-rev'` |
| R-3 | as R-1 | same | Net-zero: summing the original's lines and the created counter-entry's lines (debit +, credit −) gives exactly `0` for `acc-cash` and exactly `0` for `acc-deferred` |
| R-4 | as R-1 | same | `create` is called once; `data.status === 'POSTED'`; lines are `[ {acc-cash, credit, '1250', 'LKR'}, {acc-deferred, debit, '1250', 'LKR'} ]` in the original's line order |
| R-5 | F1 with line currencies `'EUR'` | same | each created line has `currency: 'EUR'` (copied, not defaulted) |
| R-6 | as R-1 | same | `create` `data.source === 'reversal'`, `data.sourceId === 'je-1'`, and `data.idempotencyKey === LedgerService.computeIdempotencyKey('reversal', 'je-1', new Date('2026-06-01T00:00:00Z'), { organizationId: 'org-1' })` |
| R-7 | F1; the in-transaction lookup `findFirst({ where: { organizationId: 'org-1', source: 'reversal', sourceId: 'je-1' } })` returns `{ id: 'je-rev-0' }` | same | rejects with an error matching `/already reversed/i`; `create` and `update` not called; evidence `record` not called |
| R-8 | F1 with `source: 'reversal'`, `sourceId: 'je-0'` | same | rejects with an error matching `/reversal entr(y|ies) cannot be reversed/i`; no `create`, no `update` |
| R-9 | as R-1 | same | the in-transaction lookup is called with `where` equal to `{ organizationId: 'org-1', source: 'reversal', sourceId: 'je-1' }` before `create` |

Existing tests in `tests/unit/journal-reverse-entry.test.ts` and their fate:

| Existing test | Fate |
|---|---|
| scopes the entry lookup by organizationId | kept unchanged |
| rejects with "not found" for another organization | kept unchanged |
| rejects reversal of a non-POSTED entry | kept unchanged |
| creates reversal lines with flipped isDebit and identical amounts | kept unchanged |
| **marks the original entry VOIDED** | **replaced** by R-1/R-2. This assertion encodes the defect: it pins the write that removes the original from the counted set while the counter-entry stays counted. Old and new assertion are shown verbatim in the diff and flagged for the independent reviewer |

Harness change (not an assertion change): the file's `mockDeps` helper gains `findFirst: vi.fn().mockResolvedValue(null)` on the transaction client mock, because the fix adds an in-transaction lookup.

## 5. Acceptance criteria — currency

`validateTrialBalance(lines)` — pure, no mocks.

| ID | Lines | Then |
|---|---|---|
| C-1 | `[ {100, debit, 'EUR'}, {100, credit, 'LKR'} ]` | `isValid === false`; `error` matches `/mixed currenc/i` and names both codes |
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
| C-8 | `status: POSTED`, lines as C-1 | rejects with `/CRITICAL LEDGER ERROR/` and `/mixed currenc/i`; `journalEntry.create` not called |

`getAccountBalance(accountId)` — `prisma.journalLine.findMany` mocked.

| ID | Counted lines returned | Then |
|---|---|---|
| C-9 | `[ {500, debit, 'LKR'}, {200, credit, 'LKR'} ]` | resolves to `Decimal('300')` (same as before the fix) |
| C-10 | `[ {500, debit, 'LKR'}, {200, credit, 'EUR'} ]` | rejects with an error matching `/mixed currenc/i` that names both codes |
| C-11 | `[]` | resolves to `Decimal(0)` (same as before the fix) |

## 6. Red and green expectations

- Red: on the unfixed tree R-1, R-2, R-3, R-5, R-6, R-7, R-8, R-9, C-1, C-2, C-6, C-8, C-10 fail. R-4, C-3, C-4, C-5, C-7, C-9, C-11 pass (they pin behaviour that must not change). No existing test fails.
- Green: all pass; full unit suite still reports 65+ files and at least 974 tests passed. The pre-existing unhandled rejection in `tests/unit/ingest-item-route.test.ts` is unrelated and expected to remain.

No test may be skipped, deleted or loosened to reach green, other than the one replacement named in section 4.

## 7. Explicitly not covered

- `toBookRow` (`src/lib/books-view.ts`): a mixed-currency row total needs a new field on `BookRow` or a page change; both are outside the permitted scope.
- Report totals (`trial-balance-report.ts`, `balance-sheet-report.ts`, `pl-statement-report.ts`, `metrics.service.ts`): they never read `currency`; outside scope.
- Draft approval (`approval.actions.ts`) strips `currency` before calling `validateTrialBalance`, so D5 does not bind there; it is a server action and outside scope.
- `DRAFT` entries are not validated by `postEntry` today and are not after the fix.
- Existing rows whose currency was inherited from a column default. No data is read or rewritten.
- Fiscal-period check and dating of the counter-entry.
- Database-level behaviour (unique index, triggers): unit tests mock prisma. The `(organizationId, idempotencyKey)` unique index is the concurrency backstop for D2 and is not exercised here.
- Callers of `reverseEntry` (`revenue.service.ts`): its lookup takes the newest `POSTED` entry for a booking; after D1 a second cancellation of the same booking would find the already-reversed original and be refused by D2 instead of being silently skipped. Not changed, flagged.

## 8. Visual checks

None. No UI file, route or rendered output changes. Jev Vision typed visual acceptance does not apply.

## 9. Rollback

Revert the single fix commit. No schema, data or configuration change accompanies it.
