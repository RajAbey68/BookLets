# Ko Lake Reconciliation Pilot (local script + cron)

Daily reconciliation of Ko Lake payout rows (`GuestPayout`) against bookings,
posting **DRAFT** journal pairs for a human to review and approve in BookLets.
Local-only by decision of 2026-07-04 (Gemini strategy review rejected the
serverless fleet for now — agentisation-design.md §9, Linear RAJ-510).

This is the **1-month kill-criteria test** from the 10–50-unit strategy:
if clean books + instant answers don't prove value at Ko Lake, the venture pivots.

**Quantified pass/fail thresholds** (proposed by the independent DeepSeek
review, 2026-07-04 — Raj to confirm or adjust before day 7 of the pilot):

| Metric | Pass threshold |
| --- | --- |
| Exception rate over the 30-day window | ≤ 2% of payout count |
| DeepSeek adjudication cost | ≤ $50/month at Ko Lake volume |
| Manual review time for exceptions | ≤ 30 min/week |

## How it works

1. Load `GuestPayout` rows with `status=PENDING` in the lookback window
   (default 30 days) and `CONFIRMED` bookings for the org.
2. **Deterministic pass** (`src/lib/reconciliation.ts`): a payout matches a
   booking iff the amounts are equal **in integer minor units** (decimal.js —
   money never touches binary floats) and the payout date is within
   **±3 calendar days (UTC)** of check-out. Exactly one candidate → match.
3. **Ambiguous rows only** (2+ equal-amount candidates) go to DeepSeek
   (direct REST, `src/lib/reconciliation-llm.ts`). The model can only select
   among the deterministic candidates or decline — a hallucinated id, any
   HTTP/parse error, or a missing key all degrade to "exception", never to a
   wrong match, and never abort the run.
4. Each confirmed match posts a **DRAFT** journal pair via
   `LedgerService.postEntry`: DR bank (default `Operating Cash`) /
   CR `Payout Clearing`. Both accounts must exist — pre-flight fails loudly,
   the job **never creates or mutates the chart of accounts** (four-eyes
   review finding). LLM-adjudicated matches carry the model's confidence and
   rationale in the memo + `agentConfidence`, and every posting is recorded in
   the `EvidenceLog`. Debits==credits is asserted
   in `buildDraftJournalInput` before posting. `source='reconciliation'`,
   `sourceId=<payout id>` makes re-runs idempotent (RAJ-284). The payout is
   flipped to `MATCHED` only after its entry persists.
5. A **one-line digest** goes to console (cron log) and, if
   `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are set, to Telegram:

   `KoLake recon 2026-07-04: matched=12 llm_resolved=2 exceptions=1 | po-7 410.00 (no booking within window)`

## Running

```bash
npm run reconcile:kolake          # one-off, uses .env
./scripts/reconcile-kolake.sh     # cron wrapper: Keychain key + log file
```

## Cron install (after merge, on the machine that runs it)

```bash
./scripts/install-reconcile-cron.sh          # daily 06:30 local, idempotent
RECON_CRON="0 7 * * *" ./scripts/install-reconcile-cron.sh   # custom schedule
tail -f ~/Library/Logs/booklets-recon.log
```

## Configuration (env)

| Var | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — (required) | Supabase Postgres (PgBouncer :6543 OK — no session-level SET is used) |
| `DEEPSEEK_API_KEY` | unset | Enables LLM adjudication; wrapper pulls it from Keychain `deepseek-api` |
| `RECON_ORG_NAME` | first org | Organization to reconcile |
| `RECON_LOOKBACK_DAYS` | `30` | Payout lookback window |
| `RECON_BANK_ACCOUNT` | `Operating Cash` | Debit-side account name |
| `RECON_CLEARING_ACCOUNT` | `Payout Clearing` | Credit-side SUSPENSE account name (must pre-exist) |
| `RECON_ALLOW_REFERENCES` | `false` | Send raw bank references to DeepSeek (withheld by default — data minimisation) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | unset | Digest delivery (console fallback) |

## Guarantees

- **No float money.** Amount comparison is integer minor units via decimal.js;
  sub-minor-unit amounts throw rather than round.
- **Deterministic first.** DeepSeek sees only rows the deterministic pass
  could not settle (P7 cost tiering; typically 0 calls/day).
- **DRAFT only.** Nothing posts to the ledger as POSTED; the 4-eyes approval
  flow in BookLets remains the gate.
- **Idempotent.** Re-running a day cannot double-post (ledger idempotency keys)
  and cannot re-match consumed payouts (status filter).
- **Exceptions surface, runs don't die.** One bad row = one digest exception.

## Tests

`tests/unit/reconciliation.test.ts`, `reconciliation-llm.test.ts`,
`reconciliation-runner.test.ts` — written first (TDD), 31 tests. Run with
`npm run test:unit`.
