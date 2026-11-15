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
 * pins the core reversal invariants: only POSTED entries are reversible and
 * reversal lines flip isDebit.
 *
 * Ledger repair (Nov 2026, docs/runs/ledger-repair-2026-11-13/TEST-PLAN.md):
 * the original used to be marked VOIDED while the counter-entry stayed
 * POSTED. Reports count POSTED entries only, so the reversed amount was
 * subtracted twice. Tests R-1..R-16 pin the repaired contract: the original
 * stays POSTED, the counter-entry is linked (source='reversal'), copies each
 * line's currency, is dated today in an open fiscal period, and a repeat
 * call returns the existing counter-entry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Decimal } from 'decimal.js';
import { Prisma } from '@prisma/client';

const originalEntry = {
  id: 'je-1',
  organizationId: 'org-1',
  status: 'POSTED',
  date: new Date('2026-06-01T00:00:00Z'),
  source: 'booking',
  sourceId: 'bk-1',
  memo: 'Initial Booking Funds: #HW-1',
  makerIdentity: 'user-0',
  lines: [
    { accountId: 'acc-cash', amount: '1250.00', isDebit: true, currency: 'LKR' },
    { accountId: 'acc-deferred', amount: '1250.00', isDebit: false, currency: 'LKR' },
  ],
};

const OPEN_PERIOD = { name: 'FY2026', isClosed: false, locked: false };

/** F1 with the two line currencies replaced (cash, deferred). */
function withCurrencies(cash: string, deferred: string) {
  return {
    ...originalEntry,
    lines: [
      { ...originalEntry.lines[0], currency: cash },
      { ...originalEntry.lines[1], currency: deferred },
    ],
  };
}

/**
 * `existingReversal` answers the "is there already a counter-entry?" lookup
 * (where.source === 'reversal'). An array is consumed one element per such
 * call, the last element repeating.
 */
function mockDeps(
  findFirstResult: unknown,
  existingReversal: unknown = null,
  period: unknown = OPEN_PERIOD,
) {
  const reversalAnswers = Array.isArray(existingReversal) ? [...existingReversal] : [existingReversal];
  const findFirst = vi.fn().mockImplementation((args: { where?: { source?: string } }) => {
    if (args?.where?.source === 'reversal') {
      const answer = reversalAnswers.length > 1 ? reversalAnswers.shift() : reversalAnswers[0];
      return Promise.resolve(answer);
    }
    return Promise.resolve(findFirstResult);
  });
  const periodFindFirst = vi.fn().mockResolvedValue(period);
  const create = vi
    .fn()
    .mockImplementation(({ data }: { data: { lines: { create: unknown[] } } }) =>
      Promise.resolve({ id: 'je-rev', ...data, lines: data.lines.create })
    );
  const update = vi.fn().mockResolvedValue({});
  const tx = { journalEntry: { create, update } };
  const $transaction = vi.fn().mockImplementation((fn: (client: typeof tx) => unknown) => fn(tx));
  vi.doMock('../../src/lib/prisma', () => ({
    prisma: { journalEntry: { findFirst }, fiscalPeriod: { findFirst: periodFindFirst }, $transaction },
    setRlsOrgContext: vi.fn().mockResolvedValue(undefined),
  }));
  const record = vi.fn().mockResolvedValue({});
  vi.doMock('../../src/lib/evidence-log.service', () => ({ EvidenceLogService: { record } }));
  return { findFirst, create, update, record, periodFindFirst };
}

type CreatedLine = { accountId: string; isDebit: boolean; amount: { toString(): string }; currency?: string };
const createdData = (create: ReturnType<typeof vi.fn>) =>
  create.mock.calls[0][0].data as {
    status: string;
    date: Date;
    source?: string;
    sourceId?: string;
    idempotencyKey?: string;
    lines: { create: CreatedLine[] };
  };

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

  // ── Ledger repair: original stays counted (D1) ────────────────────────────

  it('R-1 leaves the original POSTED: the single update carries no status', async () => {
    const { update } = mockDeps(originalEntry);
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await LedgerService.reverseEntry('org-1', 'je-1', 'reason', 'user-1');

    expect(update).toHaveBeenCalledOnce();
    const arg = update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'je-1' });
    expect(Object.keys(arg.data)).not.toContain('status');
  });

  it('R-2 appends the counter-entry id to the original memo', async () => {
    const { update } = mockDeps(originalEntry);
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await LedgerService.reverseEntry('org-1', 'je-1', 'reason', 'user-1');

    expect(update.mock.calls[0][0].data.memo).toBe('Initial Booking Funds: #HW-1 | Reversed by je-rev');
  });

  it('R-3 original plus counter-entry net to zero over the POSTED (counted) entries', async () => {
    const { create, update } = mockDeps(originalEntry);
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await LedgerService.reverseEntry('org-1', 'je-1', 'reason', 'user-1');

    const updateData = (update.mock.calls[0]?.[0]?.data ?? {}) as { status?: string };
    const originalStatus = 'status' in updateData ? updateData.status : originalEntry.status;
    const counter = createdData(create);
    const counted: { accountId: string; isDebit: boolean; amount: { toString(): string } }[] = [];
    if (originalStatus === 'POSTED') counted.push(...originalEntry.lines);
    if (counter.status === 'POSTED') counted.push(...counter.lines.create);

    const net = (accountId: string) =>
      counted
        .filter((l) => l.accountId === accountId)
        .reduce(
          (acc, l) => (l.isDebit ? acc.plus(new Decimal(l.amount.toString())) : acc.minus(new Decimal(l.amount.toString()))),
          new Decimal(0),
        );
    expect(net('acc-cash').toString()).toBe('0');
    expect(net('acc-deferred').toString()).toBe('0');
  });

  it('R-4 creates one POSTED counter-entry with flipped lines in the original order', async () => {
    const { create } = mockDeps(originalEntry);
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await LedgerService.reverseEntry('org-1', 'je-1', 'reason', 'user-1');

    expect(create).toHaveBeenCalledOnce();
    const data = createdData(create);
    expect(data.status).toBe('POSTED');
    const lines = data.lines.create.map((l) => [l.accountId, l.isDebit, l.amount.toString()]);
    expect(lines).toEqual([
      ['acc-cash', false, '1250'],
      ['acc-deferred', true, '1250'],
    ]);
  });

  // ── Currency is copied, never defaulted (D4) ──────────────────────────────

  it('R-5a copies LKR onto every counter-entry line', async () => {
    const { create } = mockDeps(originalEntry);
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await LedgerService.reverseEntry('org-1', 'je-1', 'reason', 'user-1');

    expect(createdData(create).lines.create.map((l) => l.currency)).toEqual(['LKR', 'LKR']);
  });

  it('R-5b copies EUR onto every counter-entry line', async () => {
    const { create } = mockDeps(withCurrencies('EUR', 'EUR'));
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await LedgerService.reverseEntry('org-1', 'je-1', 'reason', 'user-1');

    expect(createdData(create).lines.create.map((l) => l.currency)).toEqual(['EUR', 'EUR']);
  });

  // ── Linkage and one reversal per entry (D2) ───────────────────────────────

  it('R-6 links the counter-entry to the original, keyed on the original\'s date', async () => {
    const { create } = mockDeps(originalEntry);
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await LedgerService.reverseEntry('org-1', 'je-1', 'reason', 'user-1');

    const data = createdData(create);
    expect(data.source).toBe('reversal');
    expect(data.sourceId).toBe('je-1');
    expect(data.idempotencyKey).toBe(
      LedgerService.computeIdempotencyKey('reversal', 'je-1', new Date('2026-06-01T00:00:00Z'), {
        organizationId: 'org-1',
      }),
    );
  });

  it('R-7 returns the existing counter-entry on a repeat call and writes nothing', async () => {
    const { create, update, record, periodFindFirst } = mockDeps(originalEntry, { id: 'je-rev-0' });
    const { LedgerService } = await import('../../src/lib/ledger.service');

    const result = await LedgerService.reverseEntry('org-1', 'je-1', 'reason', 'user-1');

    expect(result.id).toBe('je-rev-0');
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(periodFindFirst).not.toHaveBeenCalled();
  });

  it('R-8 refuses to reverse a counter-entry', async () => {
    const { create, update } = mockDeps({ ...originalEntry, source: 'reversal', sourceId: 'je-0' });
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await expect(
      LedgerService.reverseEntry('org-1', 'je-1', 'reason', 'user-1')
    ).rejects.toThrow(/reversal entr(y|ies) cannot be reversed/i);
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('R-9 looks for an existing counter-entry, org-scoped, before creating one', async () => {
    const { findFirst, create } = mockDeps(originalEntry);
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await LedgerService.reverseEntry('org-1', 'je-1', 'reason', 'user-1');

    const idx = findFirst.mock.calls.findIndex(
      ([arg]) => (arg as { where?: { source?: string } })?.where?.source === 'reversal',
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    expect((findFirst.mock.calls[idx][0] as { where: unknown }).where).toEqual({
      organizationId: 'org-1',
      source: 'reversal',
      sourceId: 'je-1',
    });
    expect(findFirst.mock.invocationCallOrder[idx]).toBeLessThan(create.mock.invocationCallOrder[0]);
  });

  it('R-10 a lost race on the unique key resolves to the winner\'s counter-entry', async () => {
    const { findFirst, create, update, record } = mockDeps(originalEntry, [null, { id: 'je-rev-0' }]);
    create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['organizationId', 'idempotencyKey'] },
      }),
    );
    const { LedgerService } = await import('../../src/lib/ledger.service');

    const result = await LedgerService.reverseEntry('org-1', 'je-1', 'reason', 'user-1');

    expect(result.id).toBe('je-rev-0');
    expect(update).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    // the recovery re-read is scoped exactly like the first lookup
    expect((findFirst.mock.calls.at(-1)![0] as { where: unknown }).where).toEqual({
      organizationId: 'org-1',
      source: 'reversal',
      sourceId: 'je-1',
    });
  });

  it('R-17 a unique-key conflict with no counter-entry to be found is rethrown unchanged', async () => {
    const { create } = mockDeps(originalEntry, null);
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['organizationId', 'idempotencyKey'] },
    });
    create.mockRejectedValue(p2002);
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await expect(LedgerService.reverseEntry('org-1', 'je-1', 'reason', 'user-1')).rejects.toBe(p2002);
  });

  it('R-18 a lost race is recovered when the conflict carries no field metadata', async () => {
    // Driver adapters may not populate meta.target on P2002.
    const { create, update } = mockDeps(originalEntry, [null, { id: 'je-rev-0' }]);
    create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
    );
    const { LedgerService } = await import('../../src/lib/ledger.service');

    const result = await LedgerService.reverseEntry('org-1', 'je-1', 'reason', 'user-1');

    expect(result.id).toBe('je-rev-0');
    expect(update).not.toHaveBeenCalled();
  });

  it('R-11 rethrows any other create failure unchanged', async () => {
    const { create } = mockDeps(originalEntry);
    const boom = new Error('db down');
    create.mockRejectedValue(boom);
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await expect(LedgerService.reverseEntry('org-1', 'je-1', 'reason', 'user-1')).rejects.toBe(boom);
  });

  // ── Counter-entry is dated today, in an open period (D6) ──────────────────

  it('R-12 refuses when today falls in a closed fiscal period', async () => {
    const { create, update } = mockDeps(originalEntry, null, { name: 'FY2026', isClosed: true, locked: false });
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await expect(LedgerService.reverseEntry('org-1', 'je-1', 'reason', 'user-1')).rejects.toThrow(/closed/i);
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('R-13 refuses when today falls in a locked fiscal period', async () => {
    const { create, update } = mockDeps(originalEntry, null, { name: 'FY2026', isClosed: false, locked: true });
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await expect(LedgerService.reverseEntry('org-1', 'je-1', 'reason', 'user-1')).rejects.toThrow(/locked/i);
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('R-14 refuses when no fiscal period is defined for today', async () => {
    const { create, update } = mockDeps(originalEntry, null, null);
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await expect(
      LedgerService.reverseEntry('org-1', 'je-1', 'reason', 'user-1')
    ).rejects.toThrow(/No fiscal period defined/);
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('R-15 checks the period of the very date it stamps on the counter-entry', async () => {
    const { create, periodFindFirst } = mockDeps(originalEntry);
    const { LedgerService } = await import('../../src/lib/ledger.service');

    const before = Date.now();
    await LedgerService.reverseEntry('org-1', 'je-1', 'reason', 'user-1');
    const after = Date.now();

    expect(periodFindFirst).toHaveBeenCalledOnce();
    expect(periodFindFirst.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
    const where = periodFindFirst.mock.calls[0][0].where as {
      organizationId: string;
      startDate: { lte: Date };
      endDate: { gte: Date };
    };
    const stamped = createdData(create).date;
    expect(stamped).toBeInstanceOf(Date);
    expect(where.organizationId).toBe('org-1');
    expect(where.startDate.lte.getTime()).toBe(stamped.getTime());
    expect(where.endDate.gte.getTime()).toBe(stamped.getTime());
    expect(stamped.getTime()).toBeGreaterThanOrEqual(before);
    expect(stamped.getTime()).toBeLessThanOrEqual(after);
  });

  it('R-16 mirrors a mixed-currency original line for line', async () => {
    const { create } = mockDeps(withCurrencies('EUR', 'LKR'));
    const { LedgerService } = await import('../../src/lib/ledger.service');

    await expect(LedgerService.reverseEntry('org-1', 'je-1', 'reason', 'user-1')).resolves.toBeDefined();

    expect(create).toHaveBeenCalledOnce();
    expect(createdData(create).lines.create.map((l) => l.currency)).toEqual(['EUR', 'LKR']);
  });
});
