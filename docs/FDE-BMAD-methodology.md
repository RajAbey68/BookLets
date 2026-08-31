# FDE × BMAD: A Merged Methodology

**Marrying Forward-Deployed Engineering's rapid solutioning with BMAD's
enterprise-class iterative build discipline — coupled by Objective-Driven
Adoption (ODA).**

- **Status:** Draft for review (Asimov + FDE NotebookLM notebooks, BookLets repo)
- **Author:** Rajiv Abeysinghe with Claude (BookLets session)
- **Date:** 2026-07-21
- **Pending input:** the RISC definition held in the FDE notebook
  (`960f1b5d-6ae4-4c97-b21c-ddfa3d0ee582`) has not yet been folded in —
  see Open Questions.

---

## 1. The two engines

### FDE — Forward-Deployed Engineering (discovery & delivery engine)

Outward-facing. An engineer embeds with real operators and answers
**"what is actually worth building, and does it survive contact with a
real user?"** Its native loop:

1. **Embed & shadow** the frontline operators (days 1–3)
2. **Ingest & model** their messy real data into a shared ontology (days 3–7)
3. **Build a thin prototype** solving one high-value friction point (days 7–10)
4. **Deploy to live production** with a small user subset and watch (day 10+)
5. **Abstract to core platform** — push generalizable capability back into
   the product (continuous)

### BMAD — Breakthrough Method of Agile AI-Driven Development (build engine)

Inward-facing and document-driven. Role agents (Analyst → PM → Architect →
Scrum Master → Dev → QA) turn a PRD and architecture document into sharded,
context-rich story files that implementation agents execute. It answers
**"how do we build this correctly, repeatably, at enterprise grade, with
agents?"**

## 2. Complement or contradict?

**They complement — because they live on different axes.** FDE is the front
of the funnel (what/why/validate); BMAD is the middle (how/build/verify).
They only contradict when run at the same altitude and cadence.

| Engine run alone | Failure mode | Fixed by the other |
|---|---|---|
| FDE alone | Cowboy coding / feature factory (`if client == "AcmeCorp"` sprawl, collapse in six months) | BMAD's Architect + QA agents force structure; the abstraction step becomes enforced, not optional |
| BMAD alone | Ivory tower: perfectly-built features nobody asked for | FDE's embed/shadow and live deploy supply real requirements and kill dead features early |

## 3. The central tension (read this section twice)

The one genuine conflict is **cadence and document weight** — and it is the
whole design problem of the merged methodology:

- **FDE's mandate is rapid solutioning.** Crude-but-working in days.
  Value is proven by a live user touching a thin prototype, not by a
  document. Ceremony is the enemy of the ten-day loop.
- **BMAD's mandate is the next iterative step: enterprise-class
  applications.** Auditability, architecture, QA gates, story-file
  traceability. Speed without these produces systems that cannot be
  operated, secured, or maintained at scale.

Run BMAD's full PRD-and-architecture ritual on every FDE micro-iteration
and you get the **"agile-fall" anti-pattern**: sprints of ticket theatre
wrapped around a rigid spec — FDE's speed lost, BMAD's rigor faked.
Run FDE's pace without BMAD's discipline and the prototype becomes the
production system — until it collapses.

**Resolution principle:** the tension is real but it is a *sequencing*
problem, not a contradiction. FDE and BMAD are two gears in one gearbox:
FDE proves value at low ceremony; the moment value is proven, the artifact
is *promoted* into BMAD's heavier machinery for hardening. Neither engine
is asked to run at the other's cadence.

## 4. The coupler: ODA (Objective-Driven Adoption)

ODA makes **the objective the contract**: an agent (or team) is done when
an *evaluator* confirms the declared outcome — a unit test, a SQL
invariant, a metric threshold, an LLM-graded rubric, or a human 4-eyes
approval. (Origin: BookLets `AGENTS_LOG.md` roadmap; prior art:
outcome-based evals, MAPE-K autonomic loops, fitness functions.)

Why ODA is precisely the missing coupler:

- It lets FDE run **fast and thin** — spike a prototype without full BMAD
  ceremony — while still guaranteeing **termination** (done = objective
  met, not tokens exhausted) and **regression safety** (a passed objective
  becomes a lockfile).
- It gives BMAD's Dev/QA agents a **crisp done-condition per story**
  instead of document adherence.
- It defines the **promotion gate** between the two engines: a prototype
  graduates from FDE-mode to BMAD-mode when its objectives pass in live
  usage, and only then does enterprise ceremony spin up.

## 5. The merged loop

One FDE cadence outside; BMAD invoked inside at proportional weight; an
ODA objective contract at every gate.

| # | Step | Engine | Objective (the contract) | Evaluator |
|---|---|---|---|---|
| 1 | **Embed & shadow** real operators | FDE | The single highest-value friction point is named | Human sign-off |
| 2 | **Ingest & model** messy data into an ontology; feeds BMAD Analyst/PM | FDE → BMAD | Data model passes declared invariants (e.g. `trial balance == 0`) | Deterministic check |
| 3 | **Plan — lightweight BMAD**: PM/Architect agents produce a *thin* PRD + architecture slice for that one friction point only | BMAD (scaled down) | Slice covers the friction point and nothing else | Architect agent + human |
| 4 | **Build thin prototype**: Scrum Master shards one story; Dev agent implements | BMAD build, FDE spirit | Story's ODA contract passes; maker/checker proposal gate | Evaluator score + checker |
| 5 | **Deploy live to a user subset**, watch real usage | FDE | Real-world metric (e.g. "receipt auto-posts at confidence ≥ 0.9") | Live metric threshold |
| 6 | **Abstract to core platform**: client-specific logic into thin layers; generalizable capability into the shared architecture; *then* full BMAD hardening (security, QA, docs) for what graduates | FDE → BMAD (full weight) | No client-conditional forks in core; enterprise gates green | QA agent + CI + human |

**Governance rule:** FDE owns the cadence and the discovery gates. BMAD is
invoked inside steps 3–4 at a weight proportional to the spike, and at full
weight only in step 6 for artifacts that earned promotion. ODA objectives
are the contract at every gate — nothing is "done" by document, only by
evidence.

**Promotion criteria (FDE-mode → BMAD-mode), all three required:**
1. Live-usage objective passed (step 5 metric held for the agreed window)
2. A named owner requests the capability as a durable product feature
3. The abstraction review confirms it generalizes (no per-client forks)

Anything failing promotion is deleted or parked — never silently kept in
production.

## 6. Application to BookLets

BookLets' schema already implements two-thirds of the ODA machinery:

- **`EvidenceLog`** (immutable hash chain) — the green-test ledger:
  regression safety and audit trail for passed objectives.
- **`ActionIntentQueue`** (maker/checker/confidence) — the proposal gate
  used at step 4.

Missing pieces to close the loop:

- An **`Objective` model** — declarative goals ("trial balance == 0",
  "revenue recognised within 24h of checkout", "receipt confidence ≥ 0.9
  ⇒ auto-post").
- An **`Evaluator`** — deterministic check or graded judgement scoring an
  attempt against an objective; failures drive retries or escalate to
  human-in-the-loop, with per-objective retry budgets for cost control.

## 7. Open questions

1. **RISC.** The FDE notebook defines RISC; that definition has not been
   read into this synthesis. If RISC prescribes its own loop or gates, it
   most plausibly slots in either as the step-3 planning discipline or as
   the promotion-review checklist — to be resolved once the notebook
   content is shared.
2. **Cadence numbers.** The 10-day FDE loop is Palantir-derived folklore;
   BookLets should calibrate its own loop length from the first two spikes.
3. **Who plays the FDE?** In a solo/small-team context the same person
   alternates modes; the methodology still works, but the promotion gate
   then *requires* the second pair of eyes (checker) to be a different
   human or a strict evaluator.

## 8. One-paragraph summary

FDE and BMAD complement each other across different axes — FDE discovers
and proves value at low ceremony against real users; BMAD hardens proven
value into enterprise-class software with agent-driven rigor. Their only
real conflict, cadence versus ceremony, is resolved by sequencing: FDE
owns the outer loop, BMAD runs inside it at proportional weight, and ODA
objective contracts gate every step so promotion from prototype to
enterprise build happens on evidence, never on documents.
