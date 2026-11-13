# PLAN — ledger correctness repair (reversal + multi-currency)

Run of the v5 prompt dated 13 Nov 2026 (prompt SHA256 `8d0fb4d3…65b7f942`, held outside the repo).

- Base: `bc2147734bc5ae792f0b451394e7875d3074cb46` (`main`), clean tree at start.
- Branch: `fix/ledger-repair-2026-11-13` (local only, never pushed).
- Allowed edits: `src/lib/ledger.service.ts`, `src/lib/books-view.ts`, unit tests, this folder.

## Stages

| Stage | Status |
|---|---|
| 1 Identity and base | DONE |
| 2 Hook / script / setup read-through | DONE |
| 3 Reversal evidence and contract | DONE — defect confirmed in source; contract CONTRACT-UNKNOWN |
| 4 Multi-currency evidence and contract | DONE — defect confirmed in source; contract CONTRACT-UNKNOWN |
| 5 Failing tests first | NOT RUN — stopped by step-5 rule (no established contract for either defect) |
| 6 Overlap check and fix | NOT RUN — no source edit made |
| 7 Full unit suite | Baseline only (untouched tree), see EVIDENCE.md |
| 8 Lint / compile | NOT RUN — no source change to check |
| 9 Anti-weakening record | DONE — diff is this folder only |

## Disposition

- Reversal: `BLOCKED: RULE-UNKNOWN`
- Multi-currency raw addition: `BLOCKED: RULE-UNKNOWN`

Both wait on decisions from Raj listed in RESUME.md.
