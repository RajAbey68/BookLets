# BookLets — Risk Decisions

Operator decisions on the 15 risks from
[`03-review-and-risks.md`](03-review-and-risks.md), captured
2026-05-19. Update this file when verdicts change; never silently
re-prioritise.

> **Verdict legend.**
> **Fix now** — start before any new feature work.
> **Fix soon** — scheduled, has a target phase.
> **Defer** — accepted risk for now; revisit on the named trigger.
> **Drop** — closed; the risk is accepted as-is, no follow-up planned.

---

## Execution queue (in order)

| # | Risk | Verdict | Trigger / target |
|---|------|---------|------------------|
| 1 | R2 — Structured logging + Sentry | **Fix now** | Before P2 |
| 2 | R12 — LLM grounding regression suite | **Fix now** | Before P9 design |
| 3 | R5 — Background-job platform | Fix soon | Before P4 (blocks P8) |
| 4 | R3 — RLS audit + cross-org test | Fix soon | Before multi-tenant |
| 5 | R6 — Externalise spreadsheet parser mapping | Fix soon | Before multi-operator |
| 6 | R10 — User-editable chart of accounts | Fix soon | Before multi-operator |
| 7 | R1 — DB region (APAC replica or move) | Fix soon | Open scheduling |

---

## Decision detail

### R1 — Single-region DB (eu-west-1, operator in LK)
**Verdict:** Fix soon.
**Recommended action:** Evaluate Supabase read-replica in
`ap-southeast-1`. If replica latency for writes is acceptable on the
Singapore-bound RPCs, set it up. Else schedule a primary move during a
quiet weekend.
**Owner / when:** Operator decides timing.

### R2 — No structured logging or alerting
**Verdict:** Fix now.
**Recommended action:** Add `pino` with a Vercel-compatible JSON
transport. Wire Sentry for client + server exceptions. Replace existing
`console.log` call sites in the actions layer with structured `logger.info`
/ `logger.error`. One PR.

### R3 — RLS coverage is implicit
**Verdict:** Fix soon.
**Recommended action:** Write an audit script that lists every domain
table and confirms a row-level-security policy exists. Add a Vitest
integration test that signs in as a synthetic non-owner JWT and confirms
zero rows return on cross-org queries.

### R4 — Server Action serialisation fragility
**Verdict:** **Drop.**
**Rationale:** The Decimal bug from PR #38 was caught by Codex review.
Developer discipline + review process is the accepted control.

### R5 — No background-job infrastructure
**Verdict:** Fix soon.
**Recommended action:** Evaluate Inngest vs Trigger.dev vs Vercel Cron +
Queue. Pick one, write a thin abstraction, ship it before P4 ingestion or
P8 OCR start. Blocks P8 specifically because OCR can't run in a 60s
serverless function.

### R6 — Parser hard-codes operator's workbook
**Verdict:** Fix soon.
**Recommended action:** Lift `COLUMN_TO_ACCOUNT` into a JSONB column on
the `Organization` row. Migration is additive. Parser loads org mapping
at parse time. Defaults to the seeded mapping for new orgs.

### R7 — Hostaway is the single bookings feed
**Verdict:** Defer.
**Revisit trigger:** Hostaway becomes unstable, OR a second channel
manager is introduced.

### R8 — Secrets sprawl in `.env.example`
**Verdict:** Defer.
**Revisit trigger:** Secret count crosses ~12 (currently 6).

### R9 — No CSP / security headers
**Verdict:** Defer.
**Revisit trigger:** Before multi-tenant, OR before opening to a
non-operator audience.

### R10 — Chart of accounts is seeded, not editable
**Verdict:** Fix soon.
**Recommended action:** Lift `Account` from seed-only to a proper CRUD
model. Add an admin UI behind a role check. Seeded list becomes the
new-org default.

### R11 — No data lifecycle / archival policy
**Verdict:** Defer.
**Revisit trigger:** A table crosses ~10M rows, OR an external compliance
requirement (GDPR data subject request, etc.).

### R12 — No automated LLM grounding tests
**Verdict:** Fix now.
**Recommended action:** Write a prompt suite NOW even though P9 isn't
designed:
- ~30 prompts: in-scope, out-of-scope, adversarial.
- Expected behaviours: which sources to cite, what to refuse.
- Stored as JSON in `tests/llm-grounding/`.
- Runner script for once the in-app chat exists.
- Acts as a forcing function: the test suite locks in the grounding
  contract before any chat infrastructure is built.

### R13 — DR / restore drill never run
**Verdict:** Defer.
**Revisit trigger:** First time data corruption is suspected, OR before
multi-operator.

### R14 — Cold-start latency on Vercel serverless
**Verdict:** **Drop.**
**Rationale:** At operator's usage frequency, cold-start latency is
acceptable. Don't optimise pre-emptively.

### R15 — Build-log secret leakage
**Verdict:** **Drop.**
**Rationale:** Current build pipeline doesn't echo secrets. Trust the
review process to catch a future change that would.

---

## Closed (Drop) summary

R4, R14, R15 are closed. They are no longer tracked in the risk register;
the rationale is preserved above in case a future change re-opens any of
them.
