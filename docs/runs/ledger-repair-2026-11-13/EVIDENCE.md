# EVIDENCE — ledger correctness repair, 13 Nov 2026

No secrets and no real ledger data in this file. All fixtures quoted are synthetic.

## Step 1 — identity and base

```
$ git rev-parse HEAD && git status --porcelain && git branch --show-current
bc2147734bc5ae792f0b451394e7875d3074cb46
main
```

Clean tree on `main`. Work branch created afterwards: `fix/ledger-repair-2026-11-13`.

## Step 2 — scripts, hooks, setup

Scripts block of `package.json` (verbatim):

```
"dev": "next dev",
"build": "next build",
"start": "next start",
"lint": "eslint",
"test:unit": "vitest run",
"test:unit:watch": "vitest",
"test:unit:coverage": "vitest run --coverage",
"test:integration:setup": "bash scripts/test-integration-setup.sh",
"test:integration": "npm run test:integration:setup && DATABASE_URL=postgresql://postgres:test@localhost:55432/booklets_test vitest run --config vitest.integration.config.ts",
"postinstall": "prisma generate",
"db:migrate": "prisma migrate deploy",
"db:seed": "prisma db seed",
"db:setup": "prisma db push && prisma db seed",
"test:smoke": "vitest run --config vitest.smoke.config.ts",
"e2e": "node scripts/e2e/run.mjs",
"e2e:quick": "node scripts/e2e/run.mjs --quick",
"e2e:make-export": "node scripts/e2e/whatsapp-export.mjs"
```

Side-effect-relevant findings:

- `postinstall` = `prisma generate`. `prisma.config.ts` does `import "dotenv/config"` and reads `DATABASE_URL`. The clone has no `.env` (only `.env.example`), and `generate` opens no database connection. It writes to `node_modules/@prisma/client` only.
- `vitest.config.ts`: `globals: true`, `environment: 'node'`, excludes `tests/integration/**` and `tests/smoke/**`. No `setupFiles`, no `globalSetup`. No env loading.
- `eslint.config.mjs`: next core-web-vitals + typescript presets, ignores only.
- No `.husky`, no `core.hooksPath`, no `.npmrc`. `.git/hooks/pre-commit` exists (copied in by the machine's `init.templatedir`): it exits 0 unless `MCP-CONFIG.md` is staged, in which case it runs a script in the home folder. Not run: every commit and apply in this run used `core.hooksPath` pointed at an empty directory.
- Lockfile: 646 resolved entries, all from `registry.npmjs.org`; 7 packages carry install scripts.

Install used: `npm ci --ignore-scripts --no-audit --no-fund` (545 packages), then `npx --no-install prisma generate` run separately after the inspection above.

NOT RUN (need live services or are forbidden by the prompt): `e2e`, `e2e:quick`, `e2e:make-export`, `test:integration`, `test:integration:setup`, `test:smoke`, `db:migrate`, `db:seed`, `db:setup`.

## Step 3 — reversal

`rg -n "revers" src prisma tests` returned 58 lines; the code path is `src/lib/ledger.service.ts:357-439`. The writes, quoted:

```ts
// ledger.service.ts:389-394
const reversedLines = originalEntry.lines.map(line => ({
  accountId: line.accountId,
  amount: new Decimal(line.amount),
  isDebit: !line.isDebit, // Flip Debit/Credit
  memo: `Reversal of Entry #${entryId}: ${reason}`
}));

// ledger.service.ts:401-413
const reversal = await tx.journalEntry.create({
  data: {
    organizationId: originalEntry.organizationId,
    date: new Date(),
    memo: `AUTO-REVERSAL: [Original Entry ID: ${entryId}] - Reason: ${reason}`,
    status: 'POSTED',
    lines: { create: reversedLines.map(line => ({
      accountId: line.accountId, amount: line.amount, isDebit: line.isDebit,
    })) }
  },

// ledger.service.ts:420-423
await tx.journalEntry.update({
  where: { id: entryId },
  data: { status: 'VOIDED', memo: (originalEntry.memo || '') + ` | Reversed by ${reversal.id}` }
});
```

### Defect, shown from source

Every aggregate reads POSTED entries only:

```
src/lib/balance-sheet-report.ts:55   journalEntry: { organizationId, status: 'POSTED', date: { lte: endOfDay } },
src/lib/trial-balance-report.ts:51   where: { journalEntry: { organizationId, status: 'POSTED' } },
src/lib/pl-statement-report.ts:71    status: 'POSTED',
src/lib/metrics.service.ts:38,57,118 status: 'POSTED',
src/lib/ledger.service.ts:661        journalEntry: { status: 'POSTED' }
src/app/actions/books.actions.ts:57,66,73  status: 'POSTED'
```

Worked through with the fixture already in `tests/unit/journal-reverse-entry.test.ts` (DR cash 1250 / CR deferred 1250):

| Moment | Counted entries | Cash | Deferred |
|---|---|---|---|
| After posting | original (POSTED) | +1250 | −1250 |
| After `reverseEntry` | counter-entry only (original is VOIDED) | −1250 | +1250 |
| Intended | — | 0 | 0 |

The original leaves the totals and the counter-entry stays, so the cancelled amount is subtracted twice. The one production caller is booking cancellation (`src/lib/revenue.service.ts:159`).

Three further faults in the same function:

1. The counter-entry lines carry no `currency` (lines 408-412), so they take the column default instead of the original's currency. `money-format.ts:24-33` records that the production default is still "EUR".
2. The counter-entry is dated `new Date()` and `checkFiscalPeriod` is not called.
3. The counter-entry has no structured link to the original (no `source`/`sourceId`); the link is memo text only.

### Contract evidence

| Source | Says |
|---|---|
| `tests/unit/journal-reverse-entry.test.ts:88-119` | Counter-entry is POSTED with flipped lines AND "marks the original entry VOIDED" |
| `docs/BRIEFING_FOR_OTHER_SERVICES.md:49-50,140` | "creates an inverse entry and marks the original VOIDED" |
| `docs/runs/FABLE5-BUILD-SPEC.md:199` | "`POSTED` (four-eyes-verified, immutable) → `VOIDED` (reversed via new entry, never deleted)" |
| `FRD.md:202` (N-01) | "Zero deletions. Reversals only." |
| Trigger migration, lines 29-30 | POSTED entries "must be voided or reversed, never deleted" |
| Trigger migration, lines 16-27 | Trigger does not require a period for reversals; "tightening that is a separate policy decision"; VOIDED marking inside a closed period stays allowed |
| `approval.service.ts:129-135` | A rejected draft also becomes VOIDED, so VOIDED cannot simply be added to report totals |

What the repository establishes: POSTED entries are never deleted (trigger BL295); fiscal locks bind date moves, not status changes; only POSTED entries may be reversed; lookup is tenant-scoped; reversal is evidenced.

What it does not establish: whether a reversal nets to zero by keeping the original POSTED (reverse) or by voiding it with no counter-entry (void). The test, the briefing and the build spec all describe doing both, which is exactly the behaviour that double-subtracts. The migration says "voided or reversed". No document or test states the net ledger effect.

**Result: CONTRACT-UNKNOWN.** Any fix either changes an existing assertion (`marks the original entry VOIDED`) or removes the counter-entry; choosing between them is a posting-semantics decision.

## Step 4 — multi-currency

`rg -n "currency" src/lib` returned 72 lines. Raw addition across currencies, in the two allowed files:

```ts
// ledger.service.ts:55-63 — validateTrialBalance, gate for every POSTED entry
let balance = new Decimal(0);
for (const line of lines) {
  const amount = new Decimal(line.amount.toString());
  if (line.isDebit) { balance = balance.plus(amount); } else { balance = balance.minus(amount); }
}
```

`line.currency` is never read. A synthetic entry DR 100 EUR / CR 100 LKR returns `isValid: true`.

```ts
// ledger.service.ts:657-671 — getAccountBalance
const lines = await prisma.journalLine.findMany({ where: { accountId, journalEntry: { status: 'POSTED' } } });
return lines.reduce((acc, curr) => curr.isDebit ? acc.plus(new Decimal(curr.amount)) : acc.minus(new Decimal(curr.amount)), new Decimal(0));
```

```ts
// books-view.ts:91-101 — toBookRow
const debitTotal = entry.lines.filter((l) => l.isDebit)
  .reduce((sum, l) => sum.plus(new Decimal(l.amount.toString())), new Decimal(0));
...
amount: debitTotal.toFixed(2),
currency: entry.lines[0]?.currency ?? BOOKS_CURRENCY,
```

A synthetic entry with debit lines 60 LKR + 40 EUR yields amount "100.00" labelled with whichever line came first.

Outside the allowed files, and larger in effect: `trial-balance-report.ts`, `balance-sheet-report.ts`, `pl-statement-report.ts`, `metrics.service.ts` and `account.service.ts` contain zero references to `currency` (`rg -c` returned no matches). The Trial Balance query selects `accountId, amount, isDebit, date` only.

How mixed rows arise today: `revenue.service.ts:212-213,250-255,337-342,384-389` and `automation.service.ts:202-203` post lines with no currency, which take the column default; the importers write `'LKR'` explicitly.

### Contract evidence

| Source | Says |
|---|---|
| `FRD.md:63` (B-07, priority P2) | "FX rate at transaction date. Reporting in base currency." Not built; no rate source in the repo |
| `docs/runs/FABLE5-BUILD-SPEC.md:216` (D-D) | Books in LKR; "Avoids fictitious 'trial balance = 0' across currencies" |
| `ocr-bridge.ts:19,143`, `statement-ingest.ts:576`, `park-reason-labels.ts:14` | Importers park non-LKR rows: "books are LKR-only for now", "no FX policy until S8" |
| `metric-drilldown.ts:89-105` + `src/app/(app)/ledger/page.tsx:83-89,160` | Only precedent for an aggregate: a mixed-currency total "is withheld rather than labelled", shown as "Mixed currencies" |
| `money-format.ts:17-34`, `20260802_currency_default_lkr` | Rows that inherited "EUR" cannot be told from real EUR rows; "that call needs eyes on real data first" |
| `tests/unit/books-actions.test.ts:96-110`, `tests/unit/ledger-service.test.ts` | Single-currency cases only; no test covers mixed currencies |

What the repository establishes: a raw sum across currencies is not a money figure and must not be labelled as one (display precedent on the ledger page).

What it does not establish: whether a mixed-currency entry may be posted at all, and if so how it balances; how an account balance or a /books row total should be expressed when currencies differ; what currency an unlabelled line has. The one stated rule (B-07 conversion) has no rate source, and inventing one is forbidden.

**Result: CONTRACT-UNKNOWN** for the posting and balance paths. For the /books row the "withhold" precedent exists but cannot be applied inside `books-view.ts` alone: it needs either a new field on `BookRow` (a shape change, which is a STOP) or a change to `src/app/(app)/books/page.tsx` (display code, outside "May change").

## Step 5 and 6 — not run

No test or source edit was made: the step-5 rule stops work on a defect whose contract is unknown.

Overlap note for whoever resumes: the held permissions candidate's file list was not available. `src/lib/ledger.service.ts` holds `updateDraftEntryFields`, the draft-edit path that editor tracking (`lastEditedBy`) would plausibly touch, and `reverseEntry` takes `makerIdentity`. No-overlap cannot be certified for that file without the manifest.

## Step 7 — baseline unit suite (untouched tree)

Run three times, same result each time:

```
$ npm run test:unit
 Test Files  65 passed (65)
      Tests  974 passed (974)
     Errors  1 error
exit 1
```

The error is pre-existing and unrelated to this assignment:

```
Unhandled Rejection
TypeError: Invalid state: ReadableStream is already closed
 ❯ ReadableByteStreamController.enqueue node:internal/webstreams/readablestream:1313:13
 ❯ node:internal/deps/undici/undici:6867:28
This error originated in "tests/unit/ingest-item-route.test.ts" test file.
The latest test that might've caused the error is "429s once the per-organisation rate limit is exhausted".
```

Environment: Node v26.7.0, npm 11.19.0 (`engines` asks for `>=20.9.0`). Not investigated further; out of scope.

## Step 8 — NOT RUN

Lint and compile were not run: no source file changed. Compilation of a candidate is unverified because there is no candidate.

## Step 9 — anti-weakening

Diff against base is this folder only; see the commit. No test, migration, server action, auth file or configuration was touched.

## Source hashes (SHA256, identical to base)

```
2d38afdea218ce631a790e3434e01d3df707bb2ae3f8ca3f6350cdb058a1355e  src/lib/ledger.service.ts
8a6cad465dc34b5d2b88cbfa80fdb04dd017c64a7d2dd41e10dc2604af37239b  src/lib/books-view.ts
47f997cdd74194eff39a25f6504c4d55daf6da5dcbe0aa8f78d0335de4a666cc  tests/unit/journal-reverse-entry.test.ts
0df9dcec8ef9fea9f50028b3eef5ecedd8693bc4c933b36842a20ce1749e96be  tests/unit/books-actions.test.ts
```

## Reviewer gates

- `typesafe-jev` decision tools: not present in this session. No decision was routed through them and none is claimed.
- EGM reviewer agents: present. Not invoked, because no design or test run reached a gate.
- Independent human review of the diff shape: NOT VERIFIED (human-only item).

## CI

No CI gate was verified from this session.
