/**
 * Voice-assistant ledger tools — the read-only registry.
 *
 * The properties worth guarding here are the safety ones, not the formatting:
 *  - the registry exposes no way to mutate the ledger
 *  - every tool refuses cleanly when the caller has no organisation, rather
 *    than falling through to an unscoped query
 *  - results stay small enough to read aloud, and say what they left out
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Decimal } from 'decimal.js';

const getPLStatementReport = vi.fn();
const getTrialBalanceReport = vi.fn();
const getBalanceSheetReport = vi.fn();
const fetchDraftReviewQueue = vi.fn();
const resolveActiveContext = vi.fn();
const getPortfolioMetrics = vi.fn();

vi.mock('@/lib/pl-statement-report', () => ({
  getPLStatementReport: (...args: unknown[]) => getPLStatementReport(...args),
}));
vi.mock('@/lib/trial-balance-report', () => ({
  getTrialBalanceReport: (...args: unknown[]) => getTrialBalanceReport(...args),
}));
vi.mock('@/lib/balance-sheet-report', () => ({
  getBalanceSheetReport: (...args: unknown[]) => getBalanceSheetReport(...args),
  // The real resolveAsOf validates YYYY-MM-DD and falls back to today; keep
  // that behaviour so the mis-heard-date test below exercises something real.
  resolveAsOf: (input?: string) =>
    input && /^\d{4}-\d{2}-\d{2}$/.test(input) ? input : '2026-07-29',
}));
vi.mock('@/app/actions/approval.actions', () => ({
  fetchDraftReviewQueue: (...args: unknown[]) => fetchDraftReviewQueue(...args),
}));
vi.mock('@/lib/auth-context', () => ({
  resolveActiveContext: (...args: unknown[]) => resolveActiveContext(...args),
}));
vi.mock('@/lib/org-context', () => ({
  // Pass-through so the tool's use of it is observable without a real ALS scope.
  runWithOrgContext: (_orgId: string, fn: () => unknown) => fn(),
}));
vi.mock('@/lib/metrics.service', () => ({
  MetricsService: { getPortfolioMetrics: (...args: unknown[]) => getPortfolioMetrics(...args) },
}));

import { LEDGER_TOOLS, findTool } from '@/lib/agent/tools';

const okContext = {
  ok: true,
  context: {
    organizationId: 'org-1',
    organizationName: 'Ko Lake Villa',
    userId: 'u1',
    role: 'OWNER',
  },
};

/** A P&L section with `count` root accounts, descending in size. */
const plSection = (count: number) => ({
  rows: Array.from({ length: count }, (_, index) => ({
    accountId: `a${index}`,
    code: `${4000 + index}`,
    name: `Account ${index}`,
    depth: 0,
    ownAmount: new Decimal(count - index),
    rolledUpAmount: new Decimal(count - index),
  })),
  total: new Decimal(count),
});

beforeEach(() => {
  vi.clearAllMocks();
  resolveActiveContext.mockResolvedValue(okContext);
});

describe('the tool registry as a whole', () => {
  it('exposes only read tools — nothing that can reach the ledger', () => {
    // A write tool arriving here would put a mis-heard number one model
    // decision away from a posted journal entry.
    const forbidden = /^(create|post|add|update|edit|delete|approve|reject|void|sync)_/;
    for (const tool of LEDGER_TOOLS) {
      expect(tool.name).not.toMatch(forbidden);
    }
    expect(LEDGER_TOOLS.map((tool) => tool.name).sort()).toEqual([
      'get_balance_sheet',
      'get_portfolio_metrics',
      'get_profit_and_loss',
      'get_trial_balance',
      'list_pending_approvals',
    ]);
  });

  it('gives every tool a name, a description, and an object schema', () => {
    for (const tool of LEDGER_TOOLS) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('resolves tools by name and returns undefined for anything else', () => {
    expect(findTool('get_trial_balance')?.name).toBe('get_trial_balance');
    expect(findTool('post_journal_entry')).toBeUndefined();
  });
});

describe('get_profit_and_loss', () => {
  const statement = () => ({
    revenue: plSection(2),
    expenses: plSection(2),
    netProfit: new Decimal('-125.5'),
  });

  it('reports totals, the loss flag, and the period covered', async () => {
    getPLStatementReport.mockResolvedValue({
      ok: true,
      organizationName: 'Ko Lake Villa',
      preset: 'QTD',
      range: { start: new Date('2026-07-01T00:00:00Z'), endExclusive: new Date('2026-07-30T00:00:00Z') },
      presetOptions: [],
      statement: statement(),
    });

    const result = await findTool('get_profit_and_loss')!.execute({ period: 'QTD' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.period).toBe('QTD');
    expect(result.data.netProfit).toBe('-125.50');
    expect(result.data.isNetLoss).toBe(true);
    // endExclusive is the start of the next day — the last covered day is the 29th.
    expect(result.data.rangeEnd).toBe('2026-07-29');
  });

  it('caps the account list and says how many it dropped', async () => {
    getPLStatementReport.mockResolvedValue({
      ok: true,
      organizationName: 'Ko Lake Villa',
      preset: 'MTD',
      range: { start: new Date('2026-07-01T00:00:00Z'), endExclusive: new Date('2026-07-30T00:00:00Z') },
      presetOptions: [],
      statement: { revenue: plSection(20), expenses: plSection(3), netProfit: new Decimal(1) },
    });

    const result = await findTool('get_profit_and_loss')!.execute({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect((result.data.topRevenueAccounts as unknown[]).length).toBe(8);
    expect(result.data.omittedRevenueAccounts).toBe(12);
    expect(result.data.omittedExpenseAccounts).toBe(0);
  });

  it('surfaces the report layer’s error rather than answering anyway', async () => {
    getPLStatementReport.mockResolvedValue({ ok: false, error: 'Not authenticated. Sign in to continue.' });

    const result = await findTool('get_profit_and_loss')!.execute({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Not authenticated/);
  });
});

describe('get_trial_balance', () => {
  it('reports whether the books balance', async () => {
    getTrialBalanceReport.mockResolvedValue({
      ok: true,
      organizationName: 'Ko Lake Villa',
      selectedPeriod: 'all',
      periodOptions: [],
      trialBalance: {
        rows: [
          { accountId: 'cash', code: '1000', name: 'Cash', type: 'ASSET', debit: new Decimal(100), credit: new Decimal(0) },
          { accountId: 'cap', code: '3000', name: 'Capital', type: 'EQUITY', debit: new Decimal(0), credit: new Decimal(100) },
        ],
        totalDebit: new Decimal(100),
        totalCredit: new Decimal(100),
        isBalanced: true,
      },
    });

    const result = await findTool('get_trial_balance')!.execute({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.isBalanced).toBe(true);
    expect(result.data.totalDebit).toBe('100.00');
    expect(result.data.accountCount).toBe(2);
  });
});

describe('get_balance_sheet', () => {
  const emptySection = { rows: [], total: new Decimal(0) };

  beforeEach(() => {
    getBalanceSheetReport.mockResolvedValue({
      ok: true,
      organizationName: 'Ko Lake Villa',
      asOf: '2026-07-29',
      balanceSheet: {
        assets: emptySection,
        liabilities: emptySection,
        equity: emptySection,
        currentPeriodEarnings: new Decimal('42.5'),
        balances: true,
      },
    });
  });

  it('passes a well-formed date straight through', async () => {
    await findTool('get_balance_sheet')!.execute({ asOf: '2026-06-30' });
    expect(getBalanceSheetReport).toHaveBeenCalledWith('2026-06-30');
  });

  it('degrades a mis-heard date to today rather than erroring', async () => {
    // Speech-to-text turns dates into prose far more often than into ISO.
    await findTool('get_balance_sheet')!.execute({ asOf: 'the end of June' });
    expect(getBalanceSheetReport).toHaveBeenCalledWith('2026-07-29');
  });
});

describe('get_portfolio_metrics', () => {
  it('refuses when there is no organisation context', async () => {
    resolveActiveContext.mockResolvedValue({ ok: false, error: 'Not authenticated. Sign in to continue.' });

    const result = await findTool('get_portfolio_metrics')!.execute({});
    expect(result.ok).toBe(false);
    expect(getPortfolioMetrics).not.toHaveBeenCalled();
  });

  it('scopes the query to the caller’s organisation', async () => {
    getPortfolioMetrics.mockResolvedValue({
      totalRevenue: 1234.5, netIncome: 400, netMargin: 32.4, occupancy: 71.25, adr: 210, revpar: 149.6,
    });

    const result = await findTool('get_portfolio_metrics')!.execute({});
    expect(getPortfolioMetrics).toHaveBeenCalledWith('org-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalRevenue).toBe('1234.50');
    expect(result.data.occupancyPercent).toBe('71.3');
  });

  it('returns an error instead of throwing when the metrics query fails', async () => {
    getPortfolioMetrics.mockRejectedValue(new Error('connection reset'));

    const result = await findTool('get_portfolio_metrics')!.execute({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The database error text must not reach something that gets read aloud.
    expect(result.error).not.toMatch(/connection reset/);
  });
});

describe('list_pending_approvals', () => {
  const draft = (isOwnDraft: boolean) => ({
    date: '2026-07-20T00:00:00.000Z',
    memo: 'SPAR groceries',
    amount: '1550.00',
    source: 'AGENT',
    parsed: { vendor: 'SPAR' },
    isOwnDraft,
  });

  it('flags drafts the caller made themselves', async () => {
    fetchDraftReviewQueue.mockResolvedValue({ items: [draft(true), draft(false)] });

    const result = await findTool('list_pending_approvals')!.execute({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Four-eyes: the caller cannot decide their own drafts, and the agent has
    // to know that to answer "can I clear these?" honestly.
    expect(result.data.ownDraftCount).toBe(1);
    expect(result.data.returnedCount).toBe(2);
    expect(result.data.isCapped).toBe(false);
  });

  it('marks the result as capped when the queue fills the page', async () => {
    fetchDraftReviewQueue.mockResolvedValue({
      items: Array.from({ length: 10 }, () => draft(false)),
    });

    const result = await findTool('list_pending_approvals')!.execute({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.isCapped).toBe(true);
  });
});
