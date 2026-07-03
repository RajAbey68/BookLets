/**
 * RAJ-290 [P1-08] — Balance Sheet report orchestration (DB layer, mocked).
 *
 * getBalanceSheetReport must:
 *  - resolve the caller's organization (unauthenticated → ok:false)
 *  - scope BOTH queries to that organization
 *  - include only POSTED journal entries dated on or before the as-of date
 *    (cumulative from inception — a balance sheet is a stock, not a flow)
 *  - validate the asOf search param and fall back to today when absent/garbage
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const accountFindMany = vi.fn();
const journalLineFindMany = vi.fn();
const resolveActiveContext = vi.fn();

vi.mock('../../src/lib/prisma', () => ({
  prisma: {
    account: { findMany: (...args: unknown[]) => accountFindMany(...args) },
    journalLine: { findMany: (...args: unknown[]) => journalLineFindMany(...args) },
  },
}));

vi.mock('../../src/lib/auth-context', () => ({
  resolveActiveContext: (...args: unknown[]) => resolveActiveContext(...args),
}));

import { getBalanceSheetReport } from '../../src/lib/balance-sheet-report';

const okContext = {
  ok: true,
  context: { organizationId: 'org-1', organizationName: 'Ko Lake Villa', userId: 'u1', role: 'OWNER' },
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveActiveContext.mockResolvedValue(okContext);
  accountFindMany.mockResolvedValue([
    { id: 'cash', parentId: null, name: 'Cash', code: '1000', type: 'ASSET' },
    { id: 'capital', parentId: null, name: 'Capital', code: '3000', type: 'EQUITY' },
  ]);
  journalLineFindMany.mockResolvedValue([
    { accountId: 'cash', amount: '100.00', isDebit: true },
    { accountId: 'capital', amount: '100.00', isDebit: false },
  ]);
});

describe('getBalanceSheetReport', () => {
  it('returns ok:false when the caller is not authenticated', async () => {
    resolveActiveContext.mockResolvedValue({ ok: false, error: 'Not authenticated. Sign in to continue.' });
    const report = await getBalanceSheetReport('2026-06-30');
    expect(report.ok).toBe(false);
    if (!report.ok) expect(report.error).toMatch(/Not authenticated/);
    expect(accountFindMany).not.toHaveBeenCalled();
    expect(journalLineFindMany).not.toHaveBeenCalled();
  });

  it('scopes accounts and journal lines to the resolved organization', async () => {
    await getBalanceSheetReport('2026-06-30');

    expect(accountFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org-1' }) }),
    );
    const lineWhere = journalLineFindMany.mock.calls[0][0].where;
    expect(lineWhere.journalEntry.organizationId).toBe('org-1');
  });

  it('includes only POSTED entries dated on or before the end of the as-of day', async () => {
    await getBalanceSheetReport('2026-06-30');

    const lineWhere = journalLineFindMany.mock.calls[0][0].where;
    expect(lineWhere.journalEntry.status).toBe('POSTED');
    const lte: Date = lineWhere.journalEntry.date.lte;
    expect(lte).toBeInstanceOf(Date);
    // End of the as-of calendar day (UTC) so same-day postings are included.
    expect(lte.toISOString()).toBe('2026-06-30T23:59:59.999Z');
    expect(lineWhere.journalEntry.date.gte).toBeUndefined(); // stock, not a flow — no lower bound
  });

  it('computes the balance sheet from the fetched data and reports the equation', async () => {
    const report = await getBalanceSheetReport('2026-06-30');
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.organizationName).toBe('Ko Lake Villa');
    expect(report.asOf).toBe('2026-06-30');
    expect(report.balanceSheet.assets.total.toFixed(2)).toBe('100.00');
    expect(report.balanceSheet.equity.total.toFixed(2)).toBe('100.00');
    expect(report.balanceSheet.balances).toBe(true);
  });

  it("falls back to today's date when asOf is missing", async () => {
    const report = await getBalanceSheetReport(undefined);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.asOf).toBe(new Date().toISOString().slice(0, 10));
  });

  it("falls back to today's date when asOf is garbage", async () => {
    for (const garbage of ['not-a-date', '2026-13-45', '2026-6-1', "');DROP TABLE--"]) {
      const report = await getBalanceSheetReport(garbage);
      expect(report.ok).toBe(true);
      if (!report.ok) continue;
      expect(report.asOf).toBe(new Date().toISOString().slice(0, 10));
    }
  });
});
