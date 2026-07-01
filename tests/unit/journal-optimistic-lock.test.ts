/**
 * RAJ-285 [P1-03] — Optimistic locking on JournalEntry.
 *
 * Two actors read the same entry (version = N), both edit, both save. Without
 * a guard the second write silently clobbers the first (lost update). The
 * version field + a conditional updateMany(where: {id, version}) makes the
 * stale write a no-op (count === 0) which we surface as OptimisticLockError.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import fs from 'fs';
import path from 'path';

// ─── schema gate ────────────────────────────────────────────────────────────

describe('RAJ-285 — schema', () => {
  const schema = fs.readFileSync(
    path.resolve(__dirname, '../../prisma/schema.prisma'),
    'utf-8'
  );
  const je = schema.match(new RegExp('model\\s+JournalEntry\\s*\\{([^}]+)\\}', 's'))![1];

  it('JournalEntry has a version Int defaulting to 1', () => {
    expect(je).toMatch(/version\s+Int\s+@default\(1\)/);
  });
});

// ─── service behaviour (mocked Prisma) ────────────────────────────────────────

describe('LedgerService.updateEntryWithVersion', () => {
  const updatedEntry = { id: 'je-1', version: 2, memo: 'fixed', lines: [] };

  beforeEach(() => vi.resetModules());

  // The update + read run inside prisma.$transaction for read-your-write
  // atomicity, so the mock exposes a tx client to the transaction callback.
  const mockPrisma = (updateMany: Mock, findUniqueOrThrow: Mock) => {
    const tx = { journalEntry: { updateMany, findUniqueOrThrow } };
    const $transaction = vi.fn().mockImplementation((fn: (client: typeof tx) => unknown) => fn(tx));
    vi.doMock('../../src/lib/prisma', () => ({ prisma: { $transaction, journalEntry: tx.journalEntry } }));
    return { $transaction };
  };

  it('updates and returns the entry (inside a transaction) when the expected version matches', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUniqueOrThrow = vi.fn().mockResolvedValue(updatedEntry);
    const { $transaction } = mockPrisma(updateMany, findUniqueOrThrow);
    const { LedgerService } = await import('../../src/lib/ledger.service');

    const result = await LedgerService.updateEntryWithVersion('je-1', 1, { memo: 'fixed' });

    expect(result).toBe(updatedEntry);
    expect($transaction).toHaveBeenCalledOnce(); // atomic update+read
    // guard is on both id AND the expected version
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'je-1', version: 1 },
        data: expect.objectContaining({ memo: 'fixed', version: { increment: 1 } }),
      })
    );
  });

  it('throws OptimisticLockError when the version has moved on (count 0)', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findUniqueOrThrow = vi.fn();
    mockPrisma(updateMany, findUniqueOrThrow);
    const { LedgerService, OptimisticLockError } = await import('../../src/lib/ledger.service');

    await expect(
      LedgerService.updateEntryWithVersion('je-1', 1, { memo: 'stale write' })
    ).rejects.toBeInstanceOf(OptimisticLockError);
    // a stale write must NOT fall through to a read
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('never lets the caller overwrite the version counter itself', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUniqueOrThrow = vi.fn().mockResolvedValue(updatedEntry);
    mockPrisma(updateMany, findUniqueOrThrow);
    const { LedgerService } = await import('../../src/lib/ledger.service');

    // caller tries to pin version to 99 — must be ignored in favour of increment
    await LedgerService.updateEntryWithVersion('je-1', 1, { version: 99 } as never);

    const dataArg = updateMany.mock.calls[0][0].data;
    expect(dataArg.version).toEqual({ increment: 1 });
  });
});
