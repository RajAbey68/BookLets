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
