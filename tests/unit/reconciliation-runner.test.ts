/**
 * Reconciliation runner — orchestrates matcher → LLM → DRAFT posting → digest.
 *
 * All effects are injected (postEntry, updatePayoutStatus, adjudicate, notify)
 * so the daily script stays a thin wiring layer and this logic is fully
 * unit-testable without a database or network.
 */
import { describe, it, expect, vi } from 'vitest';
import { runReconciliation, type RunnerDeps } from '../../src/lib/reconciliation-runner';
import type { PayoutRow, BookingRow } from '../../src/lib/reconciliation';

const accounts = { bankAccountId: 'acct-bank', clearingAccountId: 'acct-clearing' };

const po = (id: string, amount: string, date: string): PayoutRow => ({
  id,
  amount,
  date: new Date(date),
  reference: null,
});
const bk = (id: string, amount: string, checkOut: string): BookingRow => ({
  id,
  totalAmount: amount,
  checkOut: new Date(checkOut),
});

function makeDeps(over: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    organizationId: 'org-1',
    accounts,
    payouts: [],
    bookings: [],
    postEntry: vi.fn().mockResolvedValue({ id: 'je-1' }),
    updatePayoutStatus: vi.fn().mockResolvedValue(undefined),
    adjudicate: vi.fn().mockResolvedValue(null),
    notify: vi.fn().mockResolvedValue(undefined),
    runDate: new Date('2026-07-04T02:00:00Z'),
    ...over,
  };
}

describe('runReconciliation', () => {
  it('posts one DRAFT journal pair per deterministic match and marks the payout MATCHED', async () => {
    const deps = makeDeps({
      payouts: [po('po-1', '1250.00', '2026-07-01T00:00:00Z')],
      bookings: [bk('bk-1', '1250.00', '2026-06-30T00:00:00Z')],
    });

    const summary = await runReconciliation(deps);

    expect(deps.postEntry).toHaveBeenCalledOnce();
    const entry = (deps.postEntry as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(entry.status).toBe('DRAFT');
    expect(entry.source).toBe('reconciliation');
    expect(entry.sourceId).toBe('po-1');
    expect(deps.updatePayoutStatus).toHaveBeenCalledWith('po-1', 'MATCHED');
    expect(summary.matched).toBe(1);
    expect(summary.exceptions).toHaveLength(0);
  });

  it('never calls the LLM when the deterministic pass resolves everything', async () => {
    const deps = makeDeps({
      payouts: [po('po-1', '100.00', '2026-07-01T00:00:00Z')],
      bookings: [bk('bk-1', '100.00', '2026-07-01T00:00:00Z')],
    });
    await runReconciliation(deps);
    expect(deps.adjudicate).not.toHaveBeenCalled();
  });

  it('routes ambiguous rows to the LLM and posts a DRAFT pair when it decides', async () => {
    const deps = makeDeps({
      payouts: [po('po-1', '500.00', '2026-07-01T00:00:00Z')],
      bookings: [
        bk('bk-1', '500.00', '2026-06-30T00:00:00Z'),
        bk('bk-2', '500.00', '2026-07-02T00:00:00Z'),
      ],
      adjudicate: vi.fn().mockResolvedValue({ bookingId: 'bk-2', confidence: 0.9, rationale: 'r' }),
    });

    const summary = await runReconciliation(deps);

    expect(deps.adjudicate).toHaveBeenCalledOnce();
    expect(deps.postEntry).toHaveBeenCalledOnce();
    const entry = (deps.postEntry as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(entry.memo).toContain('bk-2');
    expect(summary.llmResolved).toBe(1);
    expect(summary.exceptions).toHaveLength(0);
  });

  it('keeps an undecided ambiguous row as an exception (no posting, no status change)', async () => {
    const deps = makeDeps({
      payouts: [po('po-1', '500.00', '2026-07-01T00:00:00Z')],
      bookings: [
        bk('bk-1', '500.00', '2026-06-30T00:00:00Z'),
        bk('bk-2', '500.00', '2026-07-02T00:00:00Z'),
      ],
    });

    const summary = await runReconciliation(deps);

    expect(deps.postEntry).not.toHaveBeenCalled();
    expect(deps.updatePayoutStatus).not.toHaveBeenCalled();
    expect(summary.exceptions).toHaveLength(1);
    expect(summary.exceptions[0].payoutId).toBe('po-1');
  });

  it('emits a one-line digest through notify', async () => {
    const deps = makeDeps({
      payouts: [
        po('po-1', '100.00', '2026-07-01T00:00:00Z'),
        po('po-2', '77.00', '2026-07-01T00:00:00Z'),
      ],
      bookings: [bk('bk-1', '100.00', '2026-07-01T00:00:00Z')],
    });

    await runReconciliation(deps);

    expect(deps.notify).toHaveBeenCalledOnce();
    const digest = (deps.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(digest).not.toContain('\n');
    expect(digest).toContain('matched=1');
    expect(digest).toContain('exceptions=1');
    expect(digest).toContain('po-2');
  });

  it('a failed posting surfaces as an exception instead of crashing the run', async () => {
    const deps = makeDeps({
      payouts: [po('po-1', '100.00', '2026-07-01T00:00:00Z')],
      bookings: [bk('bk-1', '100.00', '2026-07-01T00:00:00Z')],
      postEntry: vi.fn().mockRejectedValue(new Error('closed fiscal period')),
    });

    const summary = await runReconciliation(deps);

    expect(summary.matched).toBe(0);
    expect(summary.exceptions).toHaveLength(1);
    expect(summary.exceptions[0].reason).toContain('closed fiscal period');
    expect(deps.updatePayoutStatus).not.toHaveBeenCalled();
  });
});
