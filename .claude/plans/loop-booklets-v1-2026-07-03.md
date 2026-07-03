# Loop Runbook — BookLets v1 roadmap completion
Date: 2026-07-03 · Pattern: sequential · Mode: safe · Operator session: claude-WhatToDo-247471

## Objective
1. Review BookLets: design/code, Supabase, security, implementation (report with findings).
2. Complete the v1 roadmap ("BookLets v1 — Make It Accounting" Linear project) and all known open Linear issues that are executable by an agent.

## Repo / environment
- Canonical repo: /Users/arajiv/BookLets (origin git@github.com:RajAbey68/BookLets.git, branch main @ 55d5723)
- Stack: Next.js + TypeScript + Prisma + PostgreSQL (Supabase) + Vitest
- CI: GitHub Actions — "Build & Lint" includes `npm audit` gate (currently red on main deps → RAJ-401)

## Quality gates (safe mode — every iteration)
- TDD: failing test first, then implementation (P4)
- `npx tsc --noEmit` clean, `npm test` green before commit
- Four-eyes: independent review via `~/bin/adversarial-review` (DeepSeek; `--panel` for release gates) — never self-review (P3)
- No `--no-verify`, no bypassing branch protection, no `--admin` merges
- Linear issue updated (status + comment) at each landing

## Iteration order (explicit queue)
| # | Item | Linear | Action |
|---|------|--------|--------|
| 1 | Unblock CI: merge dependabot PRs #46–49 (vitest/vite, esbuild, js-yaml, hono); re-audit; fix residual vulns (next, next-auth, postcss) | RAJ-401 | merge + verify |
| 2 | Linear hygiene: RAJ-284/285 → Done (PR #40 merged); mark old backlog project duplicates | RAJ-284/285, RAJ-340–362 | update |
| 3 | Review sweep: code-reviewer + security-reviewer + database-reviewer agents on repo; Supabase advisors (security+performance) | — | report |
| 4 | Account.type ENUM + isHeader (blocks P&L) | RAJ-403 | TDD feature |
| 5 | Org-scoped parentId constraint | RAJ-404 | TDD feature |
| 6 | orgId in optimistic-lock updateMany guard | RAJ-410 | TDD fix |
| 7 | P&L statement page with rollup | RAJ-289 | TDD feature |
| 8 | Balance Sheet page | RAJ-290 | TDD feature |
| 9 | Dashboard drill-down | RAJ-291 | TDD feature |
| 10 | Fiscal period DB trigger | RAJ-282 | TDD migration |
| 11 | Block POSTED deletion at DB level | RAJ-295 | TDD migration |
| 12 | DB indexes | RAJ-281 | migration |
| 13 | Env var audit | RAJ-280 | fix |
| 14 | CI pipeline hardening (coverage gate, prisma validate) | RAJ-279 | ci |
| 15 | Idempotency mandatory key / audit-log / retry / soft-delete follow-ups | RAJ-409/411/400/398/393/394/402 | TDD, as budget allows |
| 16 | RLS on all tables + audit | RAJ-293/278(RLS part) | TDD migration |

## Owner-gated items (do NOT execute — report only)
- RAJ-277 Vercel Pro + custom domain (paid)
- RAJ-278 Supabase Pro upgrade (paid; the RLS audit portion is executable)
- Any production data mutation

## Stop conditions
- Queue exhausted, or
- CI red on main for a cause not fixable in-repo, or
- Any gate requires owner credentials/payment, or
- 2 consecutive failed iterations on the same item (park it, move on; if 2 items parked consecutively, stop and report)

## Monitoring
- `gh run list -R RajAbey68/BookLets -L 5` for CI
- Linear project: BookLets v1 — Make It Accounting
- This file is updated with a ✅/⏸/❌ per row as the loop progresses.
