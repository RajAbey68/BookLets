/**
 * RAJ-296 / RAJ-282 — fiscal-period posting gate.
 *
 * The Linear spec for the integration suite (RAJ-296) requires "closed period
 * rejected" coverage; none existed. RAJ-282's wording is "closed/locked
 * FiscalPeriod" — the FiscalPeriod model has BOTH `isClosed` and `locked`
 * flags, and checkFiscalPeriod only honoured `isClosed`. A period an
 * accountant has locked (e.g. under audit) must reject postings the same way
 * a closed one does.
 *
 * Locked-period test is INTENTIONALLY FAILING until the service checks it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const openPeriod = {
  id: 'fp-1',
  name: 'FY26-Q3',
  organizationId: 'org-a',
  startDate: new Date('2026-07-01'),
  endDate: new Date('2026-09-30'),
  isClosed: false,
  locked: false,
};

describe('LedgerService.checkFiscalPeriod', () => {
  beforeEach(() => vi.resetModules());

  const mockPrisma = (period: typeof openPeriod | null) => {
    vi.doMock('../../src/lib/prisma', () => ({
      prisma: { fiscalPeriod: { findFirst: vi.fn().mockResolvedValue(period) } },
    }));
  };

  it('accepts a date inside an open, unlocked period', async () => {
    mockPrisma(openPeriod);
    const { LedgerService } = await import('../../src/lib/ledger.service');
    await expect(
      LedgerService.checkFiscalPeriod('org-a', new Date('2026-07-15')),
    ).resolves.toBe(true);
  });

  it('rejects a date with no fiscal period defined', async () => {
    mockPrisma(null);
    const { LedgerService } = await import('../../src/lib/ledger.service');
    await expect(
      LedgerService.checkFiscalPeriod('org-a', new Date('2031-01-01')),
    ).rejects.toThrow(/no fiscal period/i);
  });

  it('rejects a date inside a CLOSED period (RAJ-296 required case)', async () => {
    mockPrisma({ ...openPeriod, isClosed: true });
    const { LedgerService } = await import('../../src/lib/ledger.service');
    await expect(
      LedgerService.checkFiscalPeriod('org-a', new Date('2026-07-15')),
    ).rejects.toThrow(/closed/i);
  });

  it('rejects a date inside a LOCKED period (RAJ-282: closed OR locked)', async () => {
    mockPrisma({ ...openPeriod, locked: true });
    const { LedgerService } = await import('../../src/lib/ledger.service');
    await expect(
      LedgerService.checkFiscalPeriod('org-a', new Date('2026-07-15')),
    ).rejects.toThrow(/locked/i);
  });
});
