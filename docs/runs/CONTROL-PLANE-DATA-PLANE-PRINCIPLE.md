# Guiding Principle: Control Plane vs. Data Plane

> Reference principle — portfolio-wide, not BookLets-specific. Governs the
> design of `PORTFOLIO-AGENT-BUS-DESIGN.md` and any future cross-project
> coordination/retrieval work.

**Never let coordination and knowledge share one system.**

- **Control plane** — decides *what happens next*: task requests, approvals,
  status, ownership, escalation. Small, structured, auditable, human-legible.
  Lives in git (issues, PRs, run-logs) — every action must be traceable to a
  commit or comment.
- **Data plane** — answers *what is already known*: semantic retrieval over
  code, docs, notes, and past decisions across projects. Large, fuzzy,
  similarity-based. Lives in a vector store — the query pattern is "find
  similar," not "find exact."

## Litmus test

If the answer to "where does this live" is "wherever's easiest," stop —
that's how the two get conflated. Ask instead: **does this represent a
decision or action that needs an audit trail (→ control plane), or a fact
or piece of context that needs to be found by meaning, not by name
(→ data plane)?**

## Composition rule

The two planes interact but never merge.
- The control plane may *reference* the data plane (a bus message can say
  "see retrieved context: `<link>`").
- The data plane never contains live task state. No "TODO" or "pending
  approval" belongs as an embedded vector — that state rots the moment it's
  embedded, because an embedding is a snapshot, not a live query.

## Standing mapping (this portfolio, 2026-07-13)

| | Control plane | Data plane |
|---|---|---|
| Mechanism | Git-based bus — per-repo run-log + portfolio-wide bus repo (`registry.json` + `[bus]` issues, see `PORTFOLIO-AGENT-BUS-DESIGN.md`) | Supabase pgvector, shared across projects |
| Written by | Whoever takes the action (Claude, Hermes) at the moment of the decision | An indexer job (Ollama embeddings, e.g. `nomic-embed-text`) run periodically over docs/code/Obsidian notes |
| Read by | The next agent picking up the task | Any agent asking "how did we solve X before" / "what's already true about Y" |
| Failure mode if misused | Approvals/state get buried in a huge, unsearchable index | Task state goes stale because nobody re-embeds it in time |

## Why this matters

Every design decision in this portfolio — the agent bus, the RAG layer, any
future tool — should be checked against this split before it's built. A
system that tries to do both (e.g., "let's just embed the run-log too" or
"let's put pending approvals in the vector DB") will silently degrade: state
goes stale, or the audit trail becomes unsearchable noise. Keep them
separate; let them reference each other; never let one absorb the other.
