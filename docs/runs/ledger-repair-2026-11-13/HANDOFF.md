# HANDOFF — ledger correctness repair, 15 Nov 2026

Produced after the fix was committed and the unit suite went green (14 Nov).
No secrets and no real ledger data are recorded here.

## Identity

- Base commit: `bc2147734bc5ae792f0b451394e7875d3074cb46` (`main` at clone time)
- Branch: `fix/ledger-repair-2026-11-13`
- PR: **#181**, head `982e8e2` (tree `7dca925`), merged 2026-11-15T17:44Z
- Merge commit: `f757d8a` (merge of `fix/ledger-repair-2026-11-13` into `main`)
- Commits merged, in order (`bc21477..f757d8a`):
  - `4fd2a04` docs(runs): ledger repair investigation — both defects BLOCKED: RULE-UNKNOWN
  - `8548769` docs(runs): test plan for ledger reversal and mixed-currency repair (pre-review)
  - `fc7309b` docs(runs): EGM + Jev review of ledger repair test plan — gate BLOCK, owner sign-off required
  - `e56d360` docs(runs): record held-candidate overlap check for ledger repair
  - `2465fab` docs(runs): owner decisions recorded; test plan passes Implementation Gate (round 3)
  - `3dd60b3` test(ledger): failing tests for reversal net-zero and mixed-currency posting (red)
  - `23aca91` fix(ledger): reversal nets to zero; refuse mixed-currency postings
  - `dce26c8` docs(runs): red/green evidence and resume state for ledger repair
  - `36d0189` docs(runs): handoff artifact route and delivery record
  - `b4d2e58` fix(ledger): address EGM code-review findings on reversal repair
  - `7e2151b` docs(runs): correct CI note — only the npm audit step failed
  - `982e8e2` docs(runs): third-party model review of ledger repair (allowed models; DeepSeek blocked)

## File manifest

Changed or added against `bc21477`:

| File | Reason |
|---|---|
| `src/lib/ledger.service.ts` | `reverseEntry`: original stays POSTED, counter-entry copies currency and is linked, dated in an open period, idempotent per original. `validateTrialBalance`: rejects a line set spanning more than one currency. |
| `tests/unit/journal-reverse-entry.test.ts` | Reversal contract tests (R-1..R-16); one pre-existing assertion replaced, flagged in EVIDENCE.md. |
| `tests/unit/ledger-service.test.ts` | Mixed-currency posting tests (C-1..C-7); the 8 existing `validateTrialBalance` tests untouched. |
| `tests/unit/journal-idempotency.test.ts` | Reversal idempotency test (C-8). |
| `docs/runs/ledger-repair-2026-11-13/*` | Run notes: PLAN, EVIDENCE, RESUME, TEST-PLAN, REVIEW-LOG, SIGNOFF, this file. |

Not changed: `src/lib/books-view.ts`, `prisma/schema.prisma`, `prisma/migrations/**`,
server actions, role/permission logic, `JournalEntry.lastEditedBy`, display code,
configuration.

## Artifact

**Post-merge:** the standalone patch file (`booklets-ledger-repair.patch`) is **retired**. It predated the
code-review fixes (`b4d2e58`) and is not the review artifact. The review candidate was PR #181 at `982e8e2`
(tree `7dca925`); it is now merged as `f757d8a` and the branch was deleted. The historical artifact route is
kept only for provenance:

```
git format-patch bc21477..982e8e2 --stdout > booklets-ledger-repair.patch   # historical only
```

## How the artifact was verified

In a clean detached worktree of `bc21477`, with `core.hooksPath` pointed at an empty
directory for every commit and apply:

1. `git apply --check` on the patch
2. actually apply it (`git am`)
3. compare `rev-parse HEAD^{tree}` with the branch tip tree
4. re-run the key unit tests on the applied candidate
5. re-check the SHA256 of every changed file against EVIDENCE.md

The transcript of that run is in the delivery report and repeated in the sidecar
handoff file outside the repository.

## Checks that gate this candidate

Run and green on 14 Nov (raw output in EVIDENCE.md addendum):

- `npm run test:unit` — **1000 passed across 65 files**, 0 failed, 0 skipped, 1 pre-existing unrelated
  unhandled rejection in `tests/unit/ingest-item-route.test.ts` (exit 1 for that reason alone; identical at
  baseline). Confirmed in CI: `Test Files 65 passed (65)` and `Tests 1000 passed (1000)`.
- CI `Build & Lint` — the only red is `npm audit --omit=dev --audit-level=critical`, which fails identically on
  `main` (`bc21477`; exit 1, critical in prod deps) and is explicitly waived as pre-existing; this change set
  touches no dependency files.
- `npx tsc --noEmit` — exit 0, no output.
- `npm run lint` — exit 0, no findings.

NOT RUN, with reasons: `npm run build` (not established as runnable offline without
production settings); `test:integration`, `test:integration:setup`, `test:smoke`,
`e2e`, `e2e:quick`, `e2e:make-export` (need live services); `db:migrate`, `db:seed`,
`db:setup` (forbidden by the assignment). The candidate is unit-tested and
type-checked, not app-verified.

## Human-only item, still open

An independent reviewer must confirm the diff matches the manifest above and that no
test was weakened beyond the single flagged replacement. Executor-side review does
not satisfy this. Release, data correction and the held permissions candidate keep
their own separate gates.

## Post-merge status (2026-11-15)

- PR **#181** merged by owner-authorised admin merge at `2026-11-15T17:44:44Z`; merge commit **`f757d8a`**;
  head branch **deleted**.
- `main` is now `f757d8a`; the tree at the reviewed head `982e8e2` is `7dca925`, verified against a clean
  checkout.
- This file was updated **after** the merge so the reviewed tip was never moved (the deferred doc cleanup).
- Remaining human-only item is unchanged: an independent reviewer confirms the diff against the manifest and
  that no test was weakened beyond the single flagged replacement. Executor-side review does not satisfy it.
