# HANDOFF — ledger correctness repair, 15 Nov 2026

Produced after the fix was committed and the unit suite went green (14 Nov).
No secrets and no real ledger data are recorded here.

## Identity

- Base commit: `bc2147734bc5ae792f0b451394e7875d3074cb46` (`main` at clone time)
- Branch: `fix/ledger-repair-2026-11-13`
- Commits, in order:
  - `4fd2a04` investigation — both defects BLOCKED: RULE-UNKNOWN
  - `8548769` test plan (pre-review)
  - `fc7309b` EGM + Jev review of test plan — gate BLOCK, owner sign-off required
  - `e56d360` held-candidate overlap check
  - `2465fab` owner decisions recorded; test plan passes Implementation Gate (round 3)
  - `3dd60b3` red tests (tests only, source unfixed)
  - `23aca91` fix (`src/lib/ledger.service.ts` only)
  - `dce26c8` red/green evidence and resume state
  - this handoff note

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

The patch is produced from the commit above, not from a dirty working tree, so no
untracked file can be silently dropped:

```
git format-patch bc21477..HEAD --stdout > booklets-ledger-repair.patch
```

The patch file and its SHA256 are kept outside the repository
(`/Users/rajabey/code/booklets-ledger-repair.patch` and
`booklets-ledger-repair.patch.sha256`) because a patch cannot contain its own hash.

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

- `npm run test:unit` — 998 passed, 0 failed, 0 skipped, 1 pre-existing unrelated
  unhandled rejection in `tests/unit/ingest-item-route.test.ts` (exit 1 for that
  reason alone; identical at baseline).
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
