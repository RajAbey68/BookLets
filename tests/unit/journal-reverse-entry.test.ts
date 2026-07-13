/**
 * RAJ-455 — LedgerService.reverseEntry tenant isolation + core behaviour.
 *
 * reverseEntry previously looked the entry up by id alone (findUnique) with
 * NO organization check — a latent cross-tenant IDOR: any caller holding a
 * foreign entry id could reverse another tenant's ledger entry. The lookup
 * is now findFirst({ where: { id, organizationId } }) so a foreign id
 * resolves to "not found", mirroring RevenueService.recordBookingPrepayment.
 *
 * This suite is the first coverage reverseEntry has ever had, so it also
 * pins the core reversal invariants: only POSTED entries are reversible,
 * reversal lines flip isDebit, and the original is marked VOIDED.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const originalEntry = {
  id: 'je-1',
  organizationId: 'org-1',
  status: 'POSTED',
  memo: 'Initial Booking Funds: #HW-1',
  makerIdentity: 'user-0',
  lines: [
    { accountId: 'acc-cash', amount: '1250.00', isDebit: true },
    { accountId: 'acc-deferred', amount: '1250.00', isDebit: false },
  ],
};

function mockDeps(findFirstResult: unknown) {
  const findFirst = vi.fn().mockResolvedValue(findFirstResult);
  const create = vi
    .fn()
    .mockImplementation(({ data }: { data: { lines: { create: unknown[] } } }) =>
      Promise.resolve({ id: 'je-rev', ...data, lines: data.lines.create })
    );
  const update = vi.fn().mockResolvedValue({});
  const tx = { journalEntry: { create, update } };
  const $transaction = vi.fn().mockImplementation((fn: (client: typeof tx) => unknown) => fn(tx));
  vi.doMock('../../src/lib/prisma', () => ({
    prisma: { journalEntry: { findFirst }, $transaction },
    setRlsOrgContext: vi.fn().mockResolvedValue(undefined),
  }));
  const record = vi.fn().mockResolvedValue({});
  vi.doMock('../../src/lib/evidence-log.service', () => ({ EvidenceLogService: { record } }));
  return { findFirst, create, update, record };
}

describe('LedgerService.reverseEntry (RAJ-455)', () => {
  beforeEach(() => vi.resetModules());

  it('scopes the entry lookup by organizationId (tenant isolation)', async () => {
    const { findFirst } = mockDeps(originalEntry);
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await LedgerService.reverseEntry('org-1', 'je-1', 'test reversal', 'user-1');

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'je-1', organizationId: 'org-1' },
        include: { lines: true },
      })
    );
  });

  it('rejects with "not found" when the entry belongs to another organization', async () => {
    // The org-scoped lookup misses: the entry exists but under a different tenant.
    const { create, update } = mockDeps(null);
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await expect(
      LedgerService.reverseEntry('org-2', 'je-1', 'cross-tenant attempt', 'attacker')
    ).rejects.toThrow(/not found/i);

    // absolutely no writes on the failure path
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects reversal of a non-POSTED entry', async () => {
    const { create } = mockDeps({ ...originalEntry, status: 'DRAFT' });
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await expect(
      LedgerService.reverseEntry('org-1', 'je-1', 'reason', 'user-1')
    ).rejects.toThrow(/Cannot reverse.*DRAFT/);
    expect(create).not.toHaveBeenCalled();
  });

  it('creates reversal lines with flipped isDebit and identical amounts', async () => {
    const { create } = mockDeps(originalEntry);
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await LedgerService.reverseEntry('org-1', 'je-1', 'Booking Cancellation', 'user-1');

    expect(create).toHaveBeenCalledOnce();
    const data = create.mock.calls[0][0].data;
    expect(data.organizationId).toBe('org-1');
    expect(data.status).toBe('POSTED');
    const lines = data.lines.create as { accountId: string; isDebit: boolean; amount: { toString(): string } }[];
    expect(lines).toHaveLength(2);
    // DR 1250 cash → CR 1250 cash; CR 1250 deferred → DR 1250 deferred
    expect(lines[0]).toMatchObject({ accountId: 'acc-cash', isDebit: false });
    expect(lines[0].amount.toString()).toBe('1250');
    expect(lines[1]).toMatchObject({ accountId: 'acc-deferred', isDebit: true });
    expect(lines[1].amount.toString()).toBe('1250');
  });

  it('marks the original entry VOIDED', async () => {
    const { update } = mockDeps(originalEntry);
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await LedgerService.reverseEntry('org-1', 'je-1', 'reason', 'user-1');

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'je-1' },
        data: expect.objectContaining({ status: 'VOIDED' }),
      })
    );
  });
});
