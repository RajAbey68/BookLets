/**
 * RAJ-289 [P1-07] — P&L report orchestration (DB layer, prisma mocked).
 *
 * getPLStatementReport resolves the caller's org, scopes the journal-line
 * aggregation to that organization + POSTED status + the preset date range,
 * and hands the result to the pure computePLStatement. These tests verify the
 * orchestration contract — auth gating, query scoping, preset fallback —
 * without a database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const groupBy = vi.fn();
const findMany = vi.fn();
const resolveActiveContext = vi.fn();

vi.mock('../../src/lib/prisma', () => ({
  prisma: {
    account: { findMany: (...args: unknown[]) => findMany(...args) },
    journalLine: { groupBy: (...args: unknown[]) => groupBy(...args) },
  },
}));
vi.mock('../../src/lib/auth-context', () => ({
  resolveActiveContext: (...args: unknown[]) => resolveActiveContext(...args),
}));

import { getPLStatementReport } from '../../src/lib/pl-statement-report';

const REF = new Date('2026-07-03T12:00:00.000Z');

const okContext = {
  ok: true,
  context: { organizationId: 'org-1', organizationName: 'Ko Lake Villa', userId: 'u-1', role: 'OWNER' },
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveActiveContext.mockResolvedValue(okContext);
  findMany.mockResolvedValue([
    { id: 'rev-airbnb', parentId: null, name: 'Airbnb', code: '4100', type: 'REVENUE' },
    { id: 'exp-clean', parentId: null, name: 'Cleaning', code: '6100', type: 'EXPENSE' },
  ]);
  groupBy.mockResolvedValue([
    { accountId: 'rev-airbnb', isDebit: false, _sum: { amount: '1000.00' } },
    { accountId: 'exp-clean', isDebit: true, _sum: { amount: '400.00' } },
  ]);
});

describe('getPLStatementReport', () => {
  it('returns the auth error when no context resolves', async () => {
    resolveActiveContext.mockResolvedValue({ ok: false, error: 'Not authenticated. Sign in to continue.' });
    const report = await getPLStatementReport('MTD', REF);
    expect(report.ok).toBe(false);
    if (!report.ok) expect(report.error).toMatch(/Not authenticated/);
    expect(groupBy).not.toHaveBeenCalled();
  });

  it('scopes accounts and line sums to the org, POSTED status, and MTD range', async () => {
    const report = await getPLStatementReport('MTD', REF);
    expect(report.ok).toBe(true);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-1' } }),
    );

    const args = groupBy.mock.calls[0][0] as {
      where: { journalEntry: { organizationId: string; status: string; date: { gte: Date; lte: Date } } };
    };
    expect(args.where.journalEntry.organizationId).toBe('org-1');
    expect(args.where.journalEntry.status).toBe('POSTED');
    expect(args.where.journalEntry.date.gte.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(args.where.journalEntry.date.lte.toISOString()).toBe('2026-07-03T23:59:59.999Z');
  });

  it('uses the YTD range when requested', async () => {
    await getPLStatementReport('YTD', REF);
    const args = groupBy.mock.calls[0][0] as { where: { journalEntry: { date: { gte: Date } } } };
    expect(args.where.journalEntry.date.gte.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('computes the statement from the aggregated sums', async () => {
    const report = await getPLStatementReport('MTD', REF);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.statement.revenue.total.toFixed(2)).toBe('1000.00');
    expect(report.statement.expenses.total.toFixed(2)).toBe('400.00');
    expect(report.statement.netProfit.toFixed(2)).toBe('600.00');
    expect(report.organizationName).toBe('Ko Lake Villa');
  });

  it('falls back to MTD for a missing or invalid preset', async () => {
    const missing = await getPLStatementReport(undefined, REF);
    expect(missing.ok && missing.preset).toBe('MTD');

    const invalid = await getPLStatementReport('LAST_YEAR', REF);
    expect(invalid.ok && invalid.preset).toBe('MTD');
    const args = groupBy.mock.calls[1][0] as { where: { journalEntry: { date: { gte: Date } } } };
    expect(args.where.journalEntry.date.gte.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('skips aggregate rows whose _sum.amount is null (no matching lines)', async () => {
    groupBy.mockResolvedValue([{ accountId: 'rev-airbnb', isDebit: false, _sum: { amount: null } }]);
    const report = await getPLStatementReport('MTD', REF);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.statement.revenue.total.toFixed(2)).toBe('0.00');
    expect(report.statement.netProfit.toFixed(2)).toBe('0.00');
  });
});
