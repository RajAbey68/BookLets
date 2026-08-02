/**
 * RAJ-674 punch-list #3 — sandbox field editing.
 *
 * LedgerService.updateDraftEntryFields is the guarded write path behind the
 * review-queue "Edit" form: a checker can correct memo/date/amount on an
 * automated DRAFT before deciding it, without bypassing any existing control.
 *
 * Every automated-origin draft (receipt OCR, zip-ingest, S1b bridge) is
 * always exactly two balanced lines (debit expense / credit cash) with equal
 * amounts on both sides — so "edit amount" means "set both lines to the new
 * amount", which trivially preserves debits==credits. This method refuses to
 * touch entries where that assumption does not hold (not DRAFT, not exactly
 * two lines, or the two lines are not already equal) rather than guessing.
 *
 * Reuses the exact optimistic-lock + org-scope guard pattern already proven
 * in journal-optimistic-lock.test.ts (updateMany where id+organizationId+
 * version+status, count===0 → OptimisticLockError).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Decimal } from 'decimal.js';

describe('LedgerService.updateDraftEntryFields', () => {
  const twoBalancedLines = [
    { id: 'jl-1', accountId: 'acct-expense', amount: '1500.0000', isDebit: true },
    { id: 'jl-2', accountId: 'acct-cash', amount: '1500.0000', isDebit: false },
  ];

  beforeEach(() => vi.resetModules());

  function mockPrisma(opts: {
    updateManyCount?: number;
    entryStatus?: string;
    lines?: typeof twoBalancedLines;
    findUniqueOrThrowResult?: unknown;
  } = {}) {
    const {
      updateManyCount = 1,
      entryStatus = 'DRAFT',
      lines = twoBalancedLines,
      findUniqueOrThrowResult,
    } = opts;

    const updateMany = vi.fn().mockResolvedValue({ count: updateManyCount });
    const findFirst = vi.fn().mockResolvedValue(
      updateManyCount === 0 ? null : { id: 'je-1', status: entryStatus, lines },
    );
    const lineUpdateMany = vi.fn().mockResolvedValue({ count: lines.length });
    const findUniqueOrThrow = vi.fn().mockResolvedValue(
      findUniqueOrThrowResult ?? { id: 'je-1', version: 2, memo: 'edited', lines },
    );

    const tx = {
      journalEntry: { updateMany, findFirst, findUniqueOrThrow },
      journalLine: { updateMany: lineUpdateMany },
    };
    const $transaction = vi.fn().mockImplementation((fn: (client: typeof tx) => unknown) => fn(tx));
    vi.doMock('../../src/lib/prisma', () => ({
      prisma: { $transaction, journalEntry: tx.journalEntry, journalLine: tx.journalLine },
      setRlsOrgContext: vi.fn().mockResolvedValue(undefined),
    }));
    const record = vi.fn().mockResolvedValue({});
    vi.doMock('../../src/lib/evidence-log.service', () => ({ EvidenceLogService: { record } }));

    return { updateMany, findFirst, lineUpdateMany, findUniqueOrThrow, $transaction, record };
  }

  it('updates memo and date via the version-guarded path (no amount change)', async () => {
    const { updateMany } = mockPrisma();
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await LedgerService.updateDraftEntryFields('je-1', 'org-1', 1, {
      memo: 'Corrected vendor name',
      date: new Date('2026-07-01T00:00:00Z'),
    });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'je-1', organizationId: 'org-1', version: 1, status: 'DRAFT' },
        data: expect.objectContaining({ memo: 'Corrected vendor name', version: { increment: 1 } }),
      }),
    );
  });

  it('rejects editing an entry that is not DRAFT — the status filter alone blocks it', async () => {
    // A non-DRAFT entry never matches {status: 'DRAFT'} in the guard, so the
    // updateMany count is 0 regardless of version — same OptimisticLockError
    // path as a stale write. This is a deliberate, not incidental, guard.
    const { updateMany } = mockPrisma({ updateManyCount: 0 });
    const { LedgerService, OptimisticLockError } = await import('../../src/lib/ledger.service');

    await expect(
      LedgerService.updateDraftEntryFields('je-1', 'org-1', 1, { memo: 'nope' }),
    ).rejects.toBeInstanceOf(OptimisticLockError);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'DRAFT' }) }),
    );
  });

  it('sets both lines to the corrected amount, preserving the balance', async () => {
    const { lineUpdateMany } = mockPrisma();
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await LedgerService.updateDraftEntryFields('je-1', 'org-1', 1, { amount: '1750.00' });

    // Decimal.toString() normalises "1750.00" → "1750" — numerically
    // identical once written to the Decimal(19,4) column, so assert value
    // equivalence rather than exact string formatting.
    expect(lineUpdateMany).toHaveBeenCalledOnce();
    const call = lineUpdateMany.mock.calls[0][0];
    expect(call.where).toEqual({ journalEntryId: 'je-1' });
    expect(new Decimal(call.data.amount).equals(new Decimal('1750.00'))).toBe(true);
  });

  it('refuses an amount edit when the entry does not have exactly two lines', async () => {
    const threeLines = [
      ...twoBalancedLines,
      { id: 'jl-3', accountId: 'acct-tax', amount: '100.0000', isDebit: true },
    ];
    mockPrisma({ lines: threeLines });
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await expect(
      LedgerService.updateDraftEntryFields('je-1', 'org-1', 1, { amount: '1750.00' }),
    ).rejects.toThrow(/exactly two lines/i);
  });

  it('refuses an amount edit when the existing two lines are not already equal (unexpected shape)', async () => {
    const unequalLines = [
      { id: 'jl-1', accountId: 'acct-expense', amount: '1500.0000', isDebit: true },
      { id: 'jl-2', accountId: 'acct-cash', amount: '1499.0000', isDebit: false },
    ];
    mockPrisma({ lines: unequalLines });
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await expect(
      LedgerService.updateDraftEntryFields('je-1', 'org-1', 1, { amount: '1750.00' }),
    ).rejects.toThrow(/not.*balanced|equal/i);
  });

  it('rejects a non-positive amount outright — never write a zero/negative line', async () => {
    mockPrisma();
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await expect(
      LedgerService.updateDraftEntryFields('je-1', 'org-1', 1, { amount: '0' }),
    ).rejects.toThrow(/positive/i);
    await expect(
      LedgerService.updateDraftEntryFields('je-1', 'org-1', 1, { amount: '-5' }),
    ).rejects.toThrow(/positive/i);
  });

  it('never lets the caller pin the version field itself', async () => {
    const { updateMany } = mockPrisma();
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await LedgerService.updateDraftEntryFields('je-1', 'org-1', 1, { memo: 'x', version: 99 } as never);

    expect(updateMany.mock.calls[0][0].data.version).toEqual({ increment: 1 });
  });
});
