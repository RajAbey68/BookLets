import {
  reconcile,
  buildDraftJournalInput,
  formatDigest,
  type PayoutRow,
  type BookingRow,
  type Match,
  type Ambiguity,
  type ReconAccountIds,
} from './reconciliation';
import type { AdjudicationDecision } from './reconciliation-llm';
import type { JournalEntryInput } from './types';

/**
 * Reconciliation runner: deterministic pass → LLM adjudication of ambiguous
 * rows → DRAFT journal pairs → one-line digest. All effects are injected so
 * the daily script (scripts/reconcile-kolake.ts) is a thin wiring layer.
 *
 * Failure containment: one bad row becomes one exception in the digest; it
 * never aborts the run. Payout status is only advanced AFTER its DRAFT entry
 * is persisted, so a crash between the two leaves a re-runnable (idempotent)
 * state, not a half-reconciled one.
 */

export interface RunnerDeps {
  organizationId: string;
  accounts: ReconAccountIds;
  payouts: PayoutRow[];
  bookings: BookingRow[];
  postEntry: (input: JournalEntryInput) => Promise<{ id: string }>;
  updatePayoutStatus: (payoutId: string, status: 'MATCHED') => Promise<void>;
  adjudicate: (ambiguity: Ambiguity) => Promise<AdjudicationDecision | null>;
  notify: (digest: string) => Promise<void>;
  runDate: Date;
}

export interface RunSummary {
  matched: number;
  llmResolved: number;
  exceptions: { payoutId: string; amount: string; reason: string }[];
  digest: string;
}

export async function runReconciliation(deps: RunnerDeps): Promise<RunSummary> {
  const result = reconcile(deps.payouts, deps.bookings);
  const exceptions: RunSummary['exceptions'] = [];
  let matched = 0;
  let llmResolved = 0;

  const postMatch = async (match: Match): Promise<boolean> => {
    try {
      const input = buildDraftJournalInput(deps.organizationId, match, deps.accounts);
      await deps.postEntry(input);
      await deps.updatePayoutStatus(match.payoutId, 'MATCHED');
      return true;
    } catch (err) {
      exceptions.push({
        payoutId: match.payoutId,
        amount: match.amount,
        reason: `posting failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return false;
    }
  };

  for (const match of result.matched) {
    if (await postMatch(match)) matched += 1;
  }

  for (const ambiguity of result.ambiguous) {
    const decision = await deps.adjudicate(ambiguity);
    if (!decision) {
      exceptions.push({
        payoutId: ambiguity.payout.id,
        amount: ambiguity.payout.amount,
        reason: `ambiguous: ${ambiguity.candidates.length} candidates, LLM declined`,
      });
      continue;
    }
    const posted = await postMatch({
      payoutId: ambiguity.payout.id,
      bookingId: decision.bookingId,
      amount: ambiguity.payout.amount,
      date: ambiguity.payout.date,
    });
    if (posted) llmResolved += 1;
  }

  for (const un of result.unmatched) {
    exceptions.push({ payoutId: un.payout.id, amount: un.payout.amount, reason: un.reason });
  }

  const digest = formatDigest({
    runDate: deps.runDate,
    matched,
    ambiguousResolved: llmResolved,
    exceptions,
  });
  await deps.notify(digest);

  return { matched, llmResolved, exceptions, digest };
}
