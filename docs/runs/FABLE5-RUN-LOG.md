# FABLE5 RUN LOG — BookLets Go-Live

> Internal bus for the autonomous Fable 5 build loop. Append-only.
> Format: `YYYY-MM-DD HH:MM | <actor> | <event>` + detail.
> Judge (Layer 2): Hermes. Go-live (Layer 3): Raj.

## RUN PARAMETERS (set before loop start)
- **Token budget: TOTAL $100** (all models). Halt + ask Raj at ceiling (spec §2.8 G2).
- **Model assignment:** Fable=Anthropic (thinking only); Builders=frontier/non-Anthropic; Checkers=non-Anthropic (DeepSeek/Gemini/GLM). P-1.
- **Branching:** one main, parallel agents per wave, rebase-merge (§2.7 D-B).
- **Decisions locked:** Wise=SoR (Hostaway sunset); LKR books; live-DRAFT ingest; Raj tests after Wave 0.

## WAVES (spec §6)
- Wave 0: S1 db-load | S2 deploy-fix | S4 conf-gate
- Wave 1: S3 rls-lock || S5 zip-ingest
- Wave 2: S6 review-ui + S7 cf3 + S8 wise (parallel)
- Wave 3: S9 reconcile
- Wave 4: S10 phantom-fix (anytime after S2)
- Close: S11 idempotency-key | S12 closed-period
- Gate: Z go-live

## SPEND TRACKING (Fable appends estimate each wave)
| Wave | Est. spend | Running total | Within $100? |
|---|---|---|---|
| (init) | 0 | 0 | yes |

## CHECKPOINTS (Layer 1 Checker + Layer 2 Hermes verdicts)
(none yet)

---

2026-07-12 15:15 | fable | LOOP START. Spec (docs/runs/FABLE5-BUILD-SPEC.md, 525 lines) pulled from origin/docs/fable5-spec and read in full. Orchestration branch: claude/prompt-looping-setup-tvqczj.
2026-07-12 15:15 | fable | RUN PARAMETERS corrected per §2.9 (append-only; supersedes header above): budget = ~12M output tokens HARD ceiling (E4), not $100. Builders = Claude agents (E3); Layer-1+Layer-2 collapse into external Hermes review via Raj paste-back. E6 boundary honoured: Fable never SSHes devserver, never runs OCR, never touches live DB — emits requests; Hermes executes and returns evidence. P-1 limitation (no non-Anthropic in-session checker) flagged per E3.
2026-07-12 15:15 | fable | Token spend to date (recon, pre-loop): ~128k output tokens (3 Explore agents). Running estimate continues at each wave boundary.
2026-07-12 15:16 | fable | WAVE 0 DISPATCH (≤3 concurrent, §6): [B-DRIFT] pre-Wave-0 doc-drift reconciliation (E5) → branch claude/fable5-doc-drift; [B-S4] S4 conf-gate, TDD RED→GREEN (M9) → branch claude/s4-conf-gate; [B-S2] S2 deploy-fix repo-side audit of prod 500 (D1) → branch claude/s2-deploy-fix. All Claude builders, worktree-isolated, branch off origin/main per D-B (short-lived branch → draft PR → rebase-merge).
2026-07-12 15:16 | fable | S1 (db-load) requires devserver → EMITTING HERMES REQUEST HR-1 per E6 (see chat + below). Fable does not execute S1; awaits Hermes evidence via Raj.
2026-07-12 15:16 | fable | HR-1 (for Hermes): (1) restore /root/BookLets/scripts/.db-env on devserver (defect D2) with raj_fin_track pooler URL; (2) 🛑1a DB-safety proof: dry-run ocr-pipeline-v3.py on 5 JSONs from /tmp/gemini-results/ — capture count(*) before/after + re-run same 5 to prove idempotent skip; (3) on 1a evidence PASS, full load of 468 JSONs; return SELECT count(*), 3 spot-check rows vs source JSON. All output verbatim, not summarized.

2026-07-12 15:20 | fable | Orchestration PR #71 opened (draft) for spec+bus branch. Vercel bot signal absorbed: TWO Vercel projects build this repo ("booklets" AND "book-lets") — duplicate-project confusion flagged into S2 evidence asks.
2026-07-12 15:45 | fable | WAVE 0 REPO-SIDE COMPLETE. All 3 builders returned clean:
  - B-DRIFT → branch claude/fable5-doc-drift @ 80bf1d4, PR #72 (draft). BRIEFING test-claim corrected (24 suites, evidence bdd8cff); ROADMAP reconciled vs git (14 issues marked done w/ SHAs; RAJ-277/278/280/293 left open). Docs-only.
  - B-S4 → branch claude/s4-conf-gate @ fa1963f, PR #73 (draft). DEFECT D3 CONFIRMED LIVE pre-fix: automation.service.ts:150 auto-POSTed at confidence>0.9. TDD RED (9 failed: 'expected POSTED to be DRAFT' @ 0.95/0.99999/1.0) → GREEN (260/260 tests). New domain rule gateAutomatedJournalEntry() — no POSTED branch exists at type level. tsc/eslint/vitest clean. Follow-up logged: LedgerService.postEntry still defaults POSTED when status omitted.
  - B-S2 → branch claude/s2-deploy-fix @ 44e2a85, PR #74 (draft). Root cause #1 (locally REPRODUCED): malformed AUTH_URL/NEXTAUTH_URL (bare domain) throws ERR_INVALID_URL in NextAuth middleware pre-app → blanket 500 incl /api/health. Also found+fixed FAIL-OPEN auth bug (missing AUTH_SECRET → unauthenticated 200). middleware.ts→src/proxy.ts (Next16 deprecation; root proxy.ts silently ignored with src/ layout). Runtime confirmation needs Vercel evidence (HR-2).
2026-07-12 15:45 | fable | HR-2 (for Hermes, Vercel): (1) env inventory prod scope — AUTH_URL/NEXTAUTH_URL exact values (scheme/whitespace), AUTH_SECRET + DATABASE_URL present; (2) runtime logs of failing prod request — MIDDLEWARE_INVOCATION_FAILED/ERR_INVALID_URL vs Prisma P1001 vs MissingSecret; (3) which of the TWO Vercel projects (booklets vs book-lets) serves prod; consider disconnecting the duplicate; (4) after PR #74 deploys: curl -i https://booklets.vercel.app/api/health.
2026-07-12 15:45 | fable | 🛑 CHECKPOINTS EMITTED to chat + bus: PRE-W0 (doc-drift), 🛑9 (S4), 🛑2-partial (S2 repo-side). Awaiting Layer-1/Layer-2 (Hermes via Raj) verdicts. S1 blocked on HR-1. Fable HOLDS wave advance until verdicts + Raj.
2026-07-12 15:45 | fable | TOKEN ESTIMATE @ Wave-0 boundary: ~450k output tokens total (recon 128k + builders 274k + orchestration). Ceiling 12M. Within budget: yes (3.8%).

## CHECKPOINT REPORTS (§7)

### CHECKPOINT PRE-W0 — doc-drift reconciliation (E5)
GOAL SEGMENT: docs no longer contradict repo reality before autonomous waves rely on them.
CHANGED: docs/BRIEFING_FOR_OTHER_SERVICES.md, ROADMAP.md, AGENTS_LOG.md (branch claude/fable5-doc-drift, PR #72)
EVIDENCE: test-file count via find = 24; every ROADMAP done-mark backed by a landing SHA verified via git merge-base --is-ancestor origin/main.
CLAIMS: briefing no longer claims zero tests; ROADMAP statuses match git history; nothing struck without evidence.
KNOWN GAPS: P1.4/SoD briefing remark left (needs workflow-level verification, in S2/S3/S8 scope); stale PR#2/PR#5 AGENTS_LOG blocks left (can't prove those PRs merged vs content landing otherwise).
ADVERSARIAL ASKS: spot-check 2 of the 14 SHAs actually contain the claimed issue's work; check nothing factual was deleted rather than annotated.
VERDICT REQUESTED: PASS to rebase-merge PR #72.

### CHECKPOINT 9 — S4 conf-gate (M9, defect D3)
GOAL SEGMENT: no automated journal entry can ever be created POSTED; confidence is not an approval mechanism.
CHANGED: src/lib/approval.service.ts, src/lib/automation.service.ts, src/components/ReceiptUploader.tsx, tests/unit/receipt-confidence-gate.test.ts (13 new), AGENTS_LOG.md (branch claude/s4-conf-gate, PR #73)
EVIDENCE:
  - test: RED 9 failed/4 passed ("expected 'POSTED' to be 'DRAFT'" at conf 0.95/0.99999/1.0) → GREEN npm run test:unit 25 files/260 tests pass
  - build: npx tsc --noEmit clean; npx eslint . --max-warnings 0 clean
  - runtime: n/a (unit-level; Prisma stubbed per repo convention)
CLAIMS: auto-POST path (automation.service.ts:150, conf>0.9) eliminated; gate is a named domain rule with DRAFT-only literal return type; RangeError on invalid confidence; legit human 4-eyes promotion path untouched.
KNOWN GAPS: SymbiOS $extends + real Postgres not exercised (no live DB in session); LedgerService.postEntry still defaults POSTED when status omitted (logged follow-up, S11/S12 candidate).
ADVERSARIAL ASKS: attack conf==1.0 edge (spec says still DRAFT — test asserts it); attack threshold-hardcoding (none should remain); attack whether any other call-site creates POSTED entries directly.
VERDICT REQUESTED: PASS to rebase-merge PR #73.

### CHECKPOINT 2-partial — S2 deploy-fix (M2, defect D1) — REPO SIDE ONLY
GOAL SEGMENT: prod 500 root-caused and repo-side hardening landed; full 🛑2 (curl prod =200) blocked on HR-2.
CHANGED: middleware.ts→src/proxy.ts, src/app/api/health/route.ts, .env.example, src/auth.config.ts, AGENTS_LOG.md (branch claude/s2-deploy-fix, PR #74)
EVIDENCE:
  - test: npm run test:unit 24 files/247 tests pass
  - build: npm run build clean WITH ZERO env vars ("✓ Compiled successfully", "ƒ Proxy (Middleware)"); tsc + eslint clean
  - runtime (local next start): no-env → /api/health 503 {"reason":"DATABASE_URL is not set"}, /login 200, protected 307→login; malformed AUTH_URL → reproduces 500 w/ named diagnostic; valid env → all green
CLAIMS: #1 root-cause candidate = malformed AUTH_URL/NEXTAUTH_URL in Vercel env (ONLY candidate reproducing blanket 500 incl. health); pre-fix middleware FAILED OPEN on missing AUTH_SECRET (security bug, now closed); root-level proxy.ts would be silently ignored (src/ layout) — placed at src/proxy.ts; health + login now survive broken auth env.
KNOWN GAPS: actual Vercel env not inspected (boundary) — root cause unconfirmed until HR-2; two Vercel projects build this repo (booklets, book-lets) — which serves prod unknown; DB reachability unverified.
ADVERSARIAL ASKS: attack the matcher regex (does api/health exclusion leak anything else?); attack !req.auth?.user gate (any valid session shape without .user?); attack whether middleware→proxy rename changes cookie/redirect semantics on this Next version.
VERDICT REQUESTED: PASS to rebase-merge PR #74 (repo side); 🛑2 milestone stays OPEN pending HR-2 evidence.

---
