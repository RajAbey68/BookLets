/**
 * RAJ-289 [P1-07] — P&L Statement computation (pure layer).
 *
 * computePLStatement takes org accounts + POSTED journal-line aggregates for a
 * period and produces Revenue and Expense sections with hierarchy rollup
 * (AccountService.rollup) and netProfit = revenue − expenses. Sign convention
 * follows AccountService.normalBalance: REVENUE is credit-normal (credits
 * positive), EXPENSE is debit-normal (debits positive). Pure Decimal math —
 * no DB.
 *
 * presetRange resolves MTD/QTD/YTD boundaries from an explicit reference date
 * (never `now()`), in UTC.
 */
import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  computePLStatement,
  presetRange,
  isPLPreset,
  type PLAccount,
  type PLLineAggregate,
} from '../../src/lib/pl-statement';

const accounts: PLAccount[] = [
  // Revenue tree: 4000 Rental Income ← { 4100 Airbnb, 4200 Direct }
  { id: 'rev-root', parentId: null, name: 'Rental Income', code: '4000', type: 'REVENUE' },
  { id: 'rev-airbnb', parentId: 'rev-root', name: 'Airbnb', code: '4100', type: 'REVENUE' },
  { id: 'rev-direct', parentId: 'rev-root', name: 'Direct Bookings', code: '4200', type: 'REVENUE' },
  // Expense tree: 6000 Operating Expenses ← { 6100 Cleaning, 6200 Utilities }
  { id: 'exp-op', parentId: null, name: 'Operating Expenses', code: '6000', type: 'EXPENSE' },
  { id: 'exp-clean', parentId: 'exp-op', name: 'Cleaning', code: '6100', type: 'EXPENSE' },
  { id: 'exp-util', parentId: 'exp-op', name: 'Utilities', code: '6200', type: 'EXPENSE' },
  // Non-P&L types — must never appear in the statement.
  { id: 'cash', parentId: null, name: 'Operating Cash', code: '1000', type: 'ASSET' },
  { id: 'prepay', parentId: null, name: 'Guest Pre-payments', code: '2000', type: 'LIABILITY' },
  { id: 'equity', parentId: null, name: 'Owner Equity', code: '3000', type: 'EQUITY' },
  { id: 'suspense', parentId: null, name: 'Suspense', code: '9999', type: 'SUSPENSE' },
];

const line = (accountId: string, amount: string, isDebit: boolean): PLLineAggregate => ({
  accountId,
  amount,
  isDebit,
});

describe('computePLStatement', () => {
  it('returns an empty statement with zero net profit for an empty period', () => {
    const pl = computePLStatement(accounts, []);
    expect(pl.revenue.rows).toHaveLength(0);
    expect(pl.expenses.rows).toHaveLength(0);
    expect(pl.revenue.total.toFixed(2)).toBe('0.00');
    expect(pl.expenses.total.toFixed(2)).toBe('0.00');
    expect(pl.netProfit.toFixed(2)).toBe('0.00');
  });

  it('shows credit-normal REVENUE and debit-normal EXPENSE as positive amounts', () => {
    // CR Airbnb 1000 / DR Cleaning 200 (cash legs excluded from P&L)
    const pl = computePLStatement(accounts, [
      line('rev-airbnb', '1000.00', false),
      line('cash', '1000.00', true),
      line('exp-clean', '200.00', true),
      line('cash', '200.00', false),
    ]);

    const airbnb = pl.revenue.rows.find((r) => r.accountId === 'rev-airbnb')!;
    const cleaning = pl.expenses.rows.find((r) => r.accountId === 'exp-clean')!;
    expect(airbnb.ownAmount.toFixed(2)).toBe('1000.00');
    expect(cleaning.ownAmount.toFixed(2)).toBe('200.00');
  });

  it('rolls child balances up into parent accounts (Cleaning → Operating Expenses)', () => {
    const pl = computePLStatement(accounts, [
      line('exp-clean', '150.00', true),
      line('exp-util', '50.00', true),
    ]);

    const op = pl.expenses.rows.find((r) => r.accountId === 'exp-op')!;
    expect(op.ownAmount.toFixed(2)).toBe('0.00'); // no direct postings
    expect(op.rolledUpAmount.toFixed(2)).toBe('200.00'); // Cleaning + Utilities
    expect(pl.expenses.total.toFixed(2)).toBe('200.00');
  });

  it('includes a parent with direct postings in both own and rolled-up amounts', () => {
    const pl = computePLStatement(accounts, [
      line('rev-root', '100.00', false),
      line('rev-airbnb', '400.00', false),
    ]);
    const root = pl.revenue.rows.find((r) => r.accountId === 'rev-root')!;
    expect(root.ownAmount.toFixed(2)).toBe('100.00');
    expect(root.rolledUpAmount.toFixed(2)).toBe('500.00');
    expect(pl.revenue.total.toFixed(2)).toBe('500.00');
  });

  it('computes netProfit = revenue − expenses', () => {
    const pl = computePLStatement(accounts, [
      line('rev-airbnb', '1000.00', false),
      line('rev-direct', '500.00', false),
      line('exp-clean', '300.00', true),
    ]);
    expect(pl.revenue.total.toFixed(2)).toBe('1500.00');
    expect(pl.expenses.total.toFixed(2)).toBe('300.00');
    expect(pl.netProfit.toFixed(2)).toBe('1200.00');
  });

  it('reports a net loss as a negative netProfit', () => {
    const pl = computePLStatement(accounts, [
      line('rev-airbnb', '100.00', false),
      line('exp-clean', '250.00', true),
    ]);
    expect(pl.netProfit.toFixed(2)).toBe('-150.00');
  });

  it('shows contra activity as negative (a refund debited to revenue)', () => {
    const pl = computePLStatement(accounts, [
      line('rev-airbnb', '1000.00', false),
      line('rev-airbnb', '100.00', true), // refund — debit against credit-normal revenue
    ]);
    const airbnb = pl.revenue.rows.find((r) => r.accountId === 'rev-airbnb')!;
    expect(airbnb.ownAmount.toFixed(2)).toBe('900.00');

    const refundOnly = computePLStatement(accounts, [line('rev-airbnb', '100.00', true)]);
    expect(refundOnly.revenue.total.toFixed(2)).toBe('-100.00');
    expect(refundOnly.netProfit.toFixed(2)).toBe('-100.00');
  });

  it('excludes ASSET, LIABILITY, EQUITY and SUSPENSE accounts entirely', () => {
    const pl = computePLStatement(accounts, [
      line('cash', '500.00', true),
      line('prepay', '300.00', false),
      line('equity', '100.00', false),
      line('suspense', '100.00', true),
    ]);
    const ids = [...pl.revenue.rows, ...pl.expenses.rows].map((r) => r.accountId);
    expect(ids).toHaveLength(0);
    expect(pl.netProfit.toFixed(2)).toBe('0.00');
  });

  it('omits P&L accounts with no activity anywhere in their subtree', () => {
    const pl = computePLStatement(accounts, [line('exp-clean', '10.00', true)]);
    const expenseIds = pl.expenses.rows.map((r) => r.accountId);
    expect(expenseIds).toContain('exp-clean');
    expect(expenseIds).toContain('exp-op'); // parent shown because a child has activity
    expect(expenseIds).not.toContain('exp-util'); // sibling with no activity omitted
    expect(pl.revenue.rows).toHaveLength(0);
  });

  it('keeps an account whose activity nets to zero (it was active this period)', () => {
    const pl = computePLStatement(accounts, [
      line('exp-clean', '50.00', true),
      line('exp-clean', '50.00', false),
    ]);
    const cleaning = pl.expenses.rows.find((r) => r.accountId === 'exp-clean');
    expect(cleaning).toBeDefined();
    expect(cleaning!.ownAmount.toFixed(2)).toBe('0.00');
  });

  it('orders rows depth-first by account code with children under their parent', () => {
    const pl = computePLStatement(accounts, [
      line('rev-direct', '10.00', false),
      line('rev-airbnb', '20.00', false),
    ]);
    expect(pl.revenue.rows.map((r) => r.accountId)).toEqual(['rev-root', 'rev-airbnb', 'rev-direct']);
    expect(pl.revenue.rows.map((r) => r.depth)).toEqual([0, 1, 1]);
  });

  it('keeps euro-cent precision with Decimal (no IEEE-754 drift)', () => {
    const pl = computePLStatement(accounts, [
      line('rev-airbnb', '0.10', false),
      line('rev-airbnb', '0.20', false),
      line('exp-clean', '0.30', true),
    ]);
    expect(pl.revenue.total.equals(new Decimal('0.30'))).toBe(true);
    expect(pl.netProfit.equals(new Decimal('0'))).toBe(true);
  });
});

// ─── Period presets ───────────────────────────────────────────────────────────

describe('presetRange', () => {
  const utc = (iso: string) => new Date(iso);

  it('MTD spans the first of the reference month to end of the reference day', () => {
    const range = presetRange('MTD', utc('2026-07-03T10:30:00.000Z'));
    expect(range.start.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-07-03T23:59:59.999Z');
  });

  it('QTD starts at the first month of the reference quarter', () => {
    expect(presetRange('QTD', utc('2026-07-03T00:00:00.000Z')).start.toISOString()).toBe('2026-07-01T00:00:00.000Z'); // Q3
    expect(presetRange('QTD', utc('2026-03-31T00:00:00.000Z')).start.toISOString()).toBe('2026-01-01T00:00:00.000Z'); // Q1
    expect(presetRange('QTD', utc('2026-12-31T00:00:00.000Z')).start.toISOString()).toBe('2026-10-01T00:00:00.000Z'); // Q4
  });

  it('YTD starts on 1 January of the reference year', () => {
    const range = presetRange('YTD', utc('2026-07-03T00:00:00.000Z'));
    expect(range.start.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-07-03T23:59:59.999Z');
  });

  it('handles the first day of a year (all presets collapse to a single day)', () => {
    const ref = utc('2026-01-01T08:00:00.000Z');
    for (const preset of ['MTD', 'QTD', 'YTD'] as const) {
      const range = presetRange(preset, ref);
      expect(range.start.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(range.end.toISOString()).toBe('2026-01-01T23:59:59.999Z');
    }
  });
});

describe('isPLPreset', () => {
  it('accepts exactly MTD, QTD and YTD', () => {
    expect(isPLPreset('MTD')).toBe(true);
    expect(isPLPreset('QTD')).toBe(true);
    expect(isPLPreset('YTD')).toBe(true);
    expect(isPLPreset('all')).toBe(false);
    expect(isPLPreset('mtd')).toBe(false);
    expect(isPLPreset('')).toBe(false);
  });
});
