/**
 * RAJ-290 [P1-08] — Balance Sheet computation (pure layer).
 *
 * computeBalanceSheet aggregates POSTED journal-line activity — cumulative
 * from inception up to an as-of date (the caller does the date filtering; a
 * balance sheet is a stock, not a flow) — into three sections:
 *
 *   ASSETS       debit-normal  (includes SUSPENSE clearing accounts)
 *   LIABILITIES  credit-normal
 *   EQUITY       credit-normal, PLUS a synthetic "Current Period Earnings"
 *                row carrying cumulative REVENUE − EXPENSE, because without
 *                closing entries the period profit lives nowhere else and the
 *                equation Assets = Liabilities + Equity would not balance.
 *
 * Hierarchy rollup via AccountService.rollup; all math in Decimal.
 */
import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  computeBalanceSheet,
  CURRENT_PERIOD_EARNINGS_ID,
  type BalanceSheetAccount,
  type BalanceSheetLine,
} from '../../src/lib/balance-sheet';

const accounts: BalanceSheetAccount[] = [
  { id: 'cash', parentId: null, name: 'Operating Cash', code: '1000', type: 'ASSET' },
  { id: 'fixed', parentId: null, name: 'Fixed Assets', code: '1500', type: 'ASSET' },
  { id: 'villa', parentId: 'fixed', name: 'Villa Building', code: '1510', type: 'ASSET' },
  { id: 'depr', parentId: 'fixed', name: 'Accumulated Depreciation', code: '1590', type: 'ASSET' },
  { id: 'loan', parentId: null, name: 'Bank Loan', code: '2500', type: 'LIABILITY' },
  { id: 'prepay', parentId: null, name: 'Guest Pre-payments', code: '2000', type: 'LIABILITY' },
  { id: 'capital', parentId: null, name: "Owner's Capital", code: '3000', type: 'EQUITY' },
  { id: 'rev', parentId: null, name: 'Rental Income', code: '4000', type: 'REVENUE' },
  { id: 'exp', parentId: null, name: 'Cleaning Expense', code: '5000', type: 'EXPENSE' },
  { id: 'susp', parentId: null, name: 'Suspense', code: '9999', type: 'SUSPENSE' },
];

const line = (accountId: string, amount: string, isDebit: boolean): BalanceSheetLine => ({
  accountId,
  amount,
  isDebit,
});

describe('computeBalanceSheet', () => {
  it('returns empty, balanced sections for an empty ledger', () => {
    const bs = computeBalanceSheet(accounts, []);
    expect(bs.assets.rows).toHaveLength(0);
    expect(bs.liabilities.rows).toHaveLength(0);
    expect(bs.equity.rows).toHaveLength(0);
    expect(bs.assets.total.toFixed(2)).toBe('0.00');
    expect(bs.liabilities.total.toFixed(2)).toBe('0.00');
    expect(bs.equity.total.toFixed(2)).toBe('0.00');
    expect(bs.currentPeriodEarnings.toFixed(2)).toBe('0.00');
    expect(bs.balances).toBe(true);
  });

  it('places a capital injection under assets and equity, and balances', () => {
    // DR Cash 1000 / CR Owner's Capital 1000
    const bs = computeBalanceSheet(accounts, [line('cash', '1000.00', true), line('capital', '1000.00', false)]);

    const cash = bs.assets.rows.find((r) => r.accountId === 'cash')!;
    const capital = bs.equity.rows.find((r) => r.accountId === 'capital')!;
    expect(cash.rolledUpBalance.toFixed(2)).toBe('1000.00');
    expect(capital.rolledUpBalance.toFixed(2)).toBe('1000.00');

    expect(bs.assets.total.toFixed(2)).toBe('1000.00');
    expect(bs.liabilities.total.toFixed(2)).toBe('0.00');
    expect(bs.equity.total.toFixed(2)).toBe('1000.00');
    expect(bs.balances).toBe(true);
  });

  it('shows liabilities credit-normal as positive', () => {
    // DR Cash 500 / CR Loan 500
    const bs = computeBalanceSheet(accounts, [line('cash', '500.00', true), line('loan', '500.00', false)]);
    const loan = bs.liabilities.rows.find((r) => r.accountId === 'loan')!;
    expect(loan.rolledUpBalance.toFixed(2)).toBe('500.00');
    expect(bs.liabilities.total.toFixed(2)).toBe('500.00');
    expect(bs.balances).toBe(true);
  });

  it('carries un-closed revenue into equity as Current Period Earnings', () => {
    // DR Cash 500 / CR Rental Income 500 — no closing entry exists
    const bs = computeBalanceSheet(accounts, [line('cash', '500.00', true), line('rev', '500.00', false)]);

    expect(bs.currentPeriodEarnings.toFixed(2)).toBe('500.00');
    const cpe = bs.equity.rows.find((r) => r.accountId === CURRENT_PERIOD_EARNINGS_ID)!;
    expect(cpe).toBeDefined();
    expect(cpe.name).toBe('Current Period Earnings');
    expect(cpe.rolledUpBalance.toFixed(2)).toBe('500.00');

    expect(bs.assets.total.toFixed(2)).toBe('500.00');
    expect(bs.equity.total.toFixed(2)).toBe('500.00');
    expect(bs.balances).toBe(true);
  });

  it('nets expenses against revenue in Current Period Earnings', () => {
    // DR Cash 1000 / CR Rev 1000, then DR Expense 300 / CR Cash 300
    const bs = computeBalanceSheet(accounts, [
      line('cash', '1000.00', true),
      line('rev', '1000.00', false),
      line('exp', '300.00', true),
      line('cash', '300.00', false),
    ]);
    expect(bs.currentPeriodEarnings.toFixed(2)).toBe('700.00');
    expect(bs.assets.total.toFixed(2)).toBe('700.00');
    expect(bs.equity.total.toFixed(2)).toBe('700.00');
    expect(bs.balances).toBe(true);
  });

  it('reports a loss as negative Current Period Earnings and still balances', () => {
    // DR Expense 200 / CR Cash 200 (no revenue)
    const bs = computeBalanceSheet(accounts, [line('exp', '200.00', true), line('cash', '200.00', false)]);
    expect(bs.currentPeriodEarnings.toFixed(2)).toBe('-200.00');
    expect(bs.assets.total.toFixed(2)).toBe('-200.00');
    expect(bs.equity.total.toFixed(2)).toBe('-200.00');
    expect(bs.balances).toBe(true);
  });

  it('omits the Current Period Earnings row when there is no P&L activity', () => {
    const bs = computeBalanceSheet(accounts, [line('cash', '100.00', true), line('capital', '100.00', false)]);
    expect(bs.equity.rows.find((r) => r.accountId === CURRENT_PERIOD_EARNINGS_ID)).toBeUndefined();
  });

  it('includes SUSPENSE accounts under assets, debit-normal', () => {
    // DR Suspense 50 / CR Prepayments 50
    const bs = computeBalanceSheet(accounts, [line('susp', '50.00', true), line('prepay', '50.00', false)]);
    const susp = bs.assets.rows.find((r) => r.accountId === 'susp')!;
    expect(susp).toBeDefined();
    expect(susp.rolledUpBalance.toFixed(2)).toBe('50.00');
    expect(bs.balances).toBe(true);
  });

  it('rolls child balances up into parents without double-counting the section total', () => {
    // DR Villa 800 + DR Cash 200 / CR Capital 1000
    const bs = computeBalanceSheet(accounts, [
      line('villa', '800.00', true),
      line('cash', '200.00', true),
      line('capital', '1000.00', false),
    ]);
    const fixed = bs.assets.rows.find((r) => r.accountId === 'fixed')!;
    expect(fixed).toBeDefined(); // parent included because a descendant has activity
    expect(fixed.ownBalance.toFixed(2)).toBe('0.00');
    expect(fixed.rolledUpBalance.toFixed(2)).toBe('800.00');

    // Total counts roots only: cash 200 + fixed 800 = 1000, not 1800.
    expect(bs.assets.total.toFixed(2)).toBe('1000.00');
    expect(bs.balances).toBe(true);
  });

  it('lists children after their parent, ordered by code', () => {
    const bs = computeBalanceSheet(accounts, [
      line('villa', '800.00', true),
      line('depr', '100.00', false),
      line('cash', '300.00', true),
      line('capital', '1000.00', false),
    ]);
    expect(bs.assets.rows.map((r) => r.accountId)).toEqual(['cash', 'fixed', 'villa', 'depr']);
    const villa = bs.assets.rows.find((r) => r.accountId === 'villa')!;
    expect(villa.depth).toBe(1);
  });

  it('shows a contra-asset (credit balance in a debit-normal account) as negative', () => {
    // DR Villa 800 / CR Depreciation 100 / CR Capital 700
    const bs = computeBalanceSheet(accounts, [
      line('villa', '800.00', true),
      line('depr', '100.00', false),
      line('capital', '700.00', false),
    ]);
    const depr = bs.assets.rows.find((r) => r.accountId === 'depr')!;
    expect(depr.rolledUpBalance.toFixed(2)).toBe('-100.00');
    expect(bs.assets.total.toFixed(2)).toBe('700.00');
    expect(bs.balances).toBe(true);
  });

  it('balances on any balanced ledger (mixed multi-entry activity)', () => {
    const bs = computeBalanceSheet(accounts, [
      // capital in
      line('cash', '5000.00', true),
      line('capital', '5000.00', false),
      // buy villa with loan + cash
      line('villa', '9000.00', true),
      line('cash', '2000.00', false),
      line('loan', '7000.00', false),
      // guest prepays
      line('cash', '450.00', true),
      line('prepay', '450.00', false),
      // earn revenue
      line('cash', '1200.00', true),
      line('rev', '1200.00', false),
      // pay expense
      line('exp', '350.00', true),
      line('cash', '350.00', false),
      // depreciation (DR expense / CR contra-asset)
      line('exp', '150.00', true),
      line('depr', '150.00', false),
    ]);
    const expected = bs.liabilities.total.plus(bs.equity.total);
    expect(bs.assets.total.equals(expected)).toBe(true);
    expect(bs.balances).toBe(true);
    expect(bs.currentPeriodEarnings.toFixed(2)).toBe('700.00');
  });

  it('keeps euro-cent precision (no floating-point drift)', () => {
    const bs = computeBalanceSheet(accounts, [
      line('cash', '0.10', true),
      line('cash', '0.20', true),
      line('capital', '0.30', false),
    ]);
    expect(bs.assets.total.equals(new Decimal('0.30'))).toBe(true);
    expect(bs.balances).toBe(true);
  });

  it('excludes accounts with no activity anywhere in their subtree', () => {
    const bs = computeBalanceSheet(accounts, [line('cash', '10.00', true), line('capital', '10.00', false)]);
    expect(bs.assets.rows.find((r) => r.accountId === 'fixed')).toBeUndefined();
    expect(bs.liabilities.rows).toHaveLength(0);
  });

  it('flags a broken ledger (unbalanced postings) via balances=false', () => {
    // Defensive: a single unbalanced line should surface, not be hidden.
    const bs = computeBalanceSheet(accounts, [line('cash', '100.00', true)]);
    expect(bs.balances).toBe(false);
  });
});
