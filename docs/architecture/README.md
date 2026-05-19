# BookLets Architecture Pack

Three sequenced documents. Read in order.

| # | Doc | What it covers |
|---|-----|----------------|
| 1 | [`01-current-state.md`](01-current-state.md) | Snapshot of what's deployed today — topology, layers, data model, auth flow, integrations. |
| 2 | [`02-target-state.md`](02-target-state.md) | Where the system is going through phases P2–P11. Includes the explicit decisions on NoSQL (no) and small language models (not yet). |
| 3 | [`03-review-and-risks.md`](03-review-and-risks.md) | Critical audit — 15 risks with severity and recommendation, plus the prioritised fix list. |

Companion docs:
- [`../HELP.md`](../HELP.md) — user-facing help.
- [`../LLM-ASSISTANT.md`](../LLM-ASSISTANT.md) — NotebookLM setup.
- [`../../AGENTS_LOG.md`](../../AGENTS_LOG.md) — engineering coordination log.

## How to read this pack

- For a **new contributor**: 01 → 02 → 03.
- For an **operator / accountant** who just wants to understand what's
  running: 01 + the diagrams in 02.
- For a **security or architectural review**: 03 first, 01 for context.
- For a **roadmap conversation**: 02, with 03 as the "what could bite us"
  reference.

Diagrams are Mermaid and render natively on GitHub.
