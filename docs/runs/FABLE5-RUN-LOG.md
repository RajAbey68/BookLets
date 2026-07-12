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

---
