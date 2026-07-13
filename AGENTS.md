<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Operator constraints (standing rules — Raj, 2026-07-13)

- Raj is NOT a coder and NOT a GitHub expert. He will NOT take any action inside
  GitHub (no approving, merging, settings changes, UI clicks). Never design a
  process that requires him to.
- Any gate needing a second GitHub identity must be satisfied by the machine
  account **HermesBot (GitHub login: `RajAbeyBot`** — the repo's only
  write-access collaborator besides Raj; token held by Hermes on devserver),
  backed by a non-Anthropic LLM review — never by Raj personally.
- Approval architecture: external LLMs (DeepSeek, Z.AI GLM, Qwen, Gemini, …)
  REVIEW and VOTE; GitHub only counts approvals from accounts, so HermesBot
  SIGNS the approval on a passing quorum, embedding the verdicts in the review
  body for audit. Claude writes; a non-Anthropic quorum approves; Fable merges.
- Raj CAN: paste messages between agents (the bus/Hermes relay), watch agents
  drive code/browser/desktop automation, and make yes/no decisions in chat.

# Long-loop operating model: Orchestrator / Best-Fit-Worker (Raj, 2026-07-13)

For any multi-step or long-running assignment in this repo (migrations, audits,
multi-PR rollouts, agent loops):

1. **One frontier model orchestrates.** It plans, decomposes, resolves
   conflicts, makes judgment calls, and is accountable for the final report.
   It does NOT do routine execution itself when a better-fit worker exists.
2. **Every subtask goes to whoever is actually best for it — not a default:**
   - Mechanical / high-volume / well-specified work → a fast, cheap model or a
     plain script. Don't spend frontier-model effort on it.
   - Domain-specialized work → the tool/model best regarded for that domain.
   - Verification, adversarial audit, or approval of the orchestrator's OWN
     output → NEVER the same model family that produced it. Use an
     independent vendor (see the external-LLM quorum above).
3. **Parallelize independent subtasks.** Serial only when there's a real
   dependency.
4. **Keep a durable, append-only log** of decisions, worker outputs, and open
   questions (this file's run-log pattern) so the loop survives context
   resets and other agents/humans can resume mid-stream.
5. **Escalate to the human only for genuine judgment calls** — authorization,
   risk tolerance, ambiguous intent. Never for anything a model or script can
   resolve on its own.
6. **Before declaring anything done**, get an independent adversarial check —
   not just a second look from the same model that built it.
7. **Report status as**: what's proven (with evidence), what's assumed,
   what's blocked, and exactly whose action unblocks it.

# Guiding principle: Control Plane vs. Data Plane (Raj, 2026-07-13)

Portfolio-wide, not BookLets-specific. Full version:
`docs/runs/CONTROL-PLANE-DATA-PLANE-PRINCIPLE.md`.

**Never let coordination and knowledge share one system.**
- **Control plane** — what happens next: task requests, approvals, status,
  ownership. Small, structured, auditable. Lives in git (issues, PRs,
  run-logs).
- **Data plane** — what is already known: semantic retrieval over code,
  docs, notes across projects. Large, fuzzy, similarity-based. Lives in a
  vector store (Supabase pgvector).

**Litmus test:** does this need an audit trail (→ control plane), or does it
need to be found by meaning, not by name (→ data plane)?

**Composition rule:** they interact but never merge. The control plane may
reference the data plane; the data plane never holds live task state (an
embedding is a snapshot, not a live query — embedded "TODO"s rot instantly).
