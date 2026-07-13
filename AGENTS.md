<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Operator constraints (standing rules — Raj, 2026-07-13)

- Raj is NOT a coder and NOT a GitHub expert. He will NOT take any action inside
  GitHub (no approving, merging, settings changes, UI clicks). Never design a
  process that requires him to.
- Any gate needing a second GitHub identity must be satisfied by the machine
  account `RajAbeyBot` (token held by Hermes on devserver), backed by a
  non-Anthropic LLM review — never by Raj personally.
- Raj CAN: paste messages between agents (the bus/Hermes relay), watch agents
  drive code/browser/desktop automation, and make yes/no decisions in chat.
