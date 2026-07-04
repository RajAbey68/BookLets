# Hermes task: merge BookLets PR queue #50–#61 (12 green, reviewed PRs)

CONTEXT / WHY HERMES: On 2026-07-03 a Claude Code session produced 12 PRs on
RajAbey68/BookLets — every one CI-green, TDD-first (RED→GREEN evidence in each
PR body), with an independent external review (envelope IDs in each body). The
Claude session's permission policy blocks it from merging to main AND from
enqueuing this task itself (merges are deliberately human/delegate-gated).
Owner Rajiv delegated merge execution to Hermes on 2026-07-03. Repo:
git@github.com:RajAbey68/BookLets.git, local checkout /Users/arajiv/BookLets,
gh CLI authenticated as RajAbey68.

MERGE ORDER (squash-merge each; after EACH merge wait for the next PR's checks
to re-run green before merging; if a PR conflicts after a prior merge, rebase
it on main, wait for green, then merge):
1. PR #51  chore(deps) npm audit fix         — FIRST (clears the audit gate)
2. PR #50  AccountType enum + org parent FK  — schema base for the stacked pair
3. PR #58  P&L statement — STACKED on #50's branch: after #50 merges, retarget
   base to main (gh pr edit 58 --base main), let checks re-run, then merge
4. PR #55  Balance Sheet — same stacked procedure as #58
5. PR #52  composite indexes
6. PR #54  fiscal-lock + POSTED-delete triggers
7. PR #57  fiscal-gate tests + locked-period fix
8. PR #59  ledger tenant hardening (adds source/sourceId migration)
9. PR #60  4-eyes approvals workflow (adds ActionIntentQueue org migration)
10. PR #56 dashboard drill-down
11. PR #61 receipt upload guards

NOTE: #50/#52/#54/#59/#60 all touch prisma/schema.prisma and add migration
folders — expect rebases between steps; migration FOLDERS never collide
(distinct dated names), only schema.prisma hunks do. Resolve rebase conflicts
by keeping BOTH sides' schema additions (they are additive: enum+fields,
@@index lines, source/sourceId fields, organizationId on ActionIntentQueue).

AFTER ALL MERGES:
- Close dependabot PRs #46, #47, #48, #49 with comment "superseded by #51".
- Merge docs PR #39 (ROADMAP/FRD/IARD) if its checks are green (it was
  branch-updated and mergeable on 2026-07-03).
- DO NOT run prisma migrations against the production database. Post a comment
  listing the 5 new migration folders and flag to Rajiv that
  `npm run db:migrate` must be run against the BookLets Supabase project
  (euqdfxekrxnoibeahogq) — owner-gated production data change.
- Linear (LINEAR_API_KEY in ~/.hermes/.env): move to Done as each PR merges:
  RAJ-401(#51), RAJ-403/404(#50), RAJ-289(#58), RAJ-290(#55), RAJ-281(#52),
  RAJ-282+295(#54+#57), RAJ-296(#57), RAJ-455/410/411(#59), RAJ-292/294(#60),
  RAJ-291(#56), RAJ-456(#61). Add the merge SHA in a comment on each.

VERIFICATION (report in a completion comment): per merge cite the merge SHA +
post-merge CI run URL on main (must be green); final checks on main:
`npm audit --omit=dev --audit-level=critical` exits 0 and `npx vitest run`
green. If any post-merge CI on main goes red: STOP, merge nothing further,
revert nothing, comment and notify Rajiv.

HARD RULES: never --admin, never bypass branch protection, never force-push.
If branch protection demands an approving review, submit one via
`gh pr review --approve` citing the independent review envelope already in the
PR body (four-eyes evidence attached to each PR). If anything is ambiguous,
stop and ask rather than improvise.
