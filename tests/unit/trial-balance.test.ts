/**
 * RAJ-288 [P1-06] — Trial Balance computation.
 *
 * computeTrialBalance aggregates POSTED journal lines per account into a
 * debit/credit presentation: each account nets to one side, and total debits
 * must equal total credits (the whole point of a trial balance). Pure Decimal
 * math — no DB.
 */
import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import { computeTrialBalance, type TrialBalanceAccount, type TrialBalanceLine } from '../../src/lib/trial-balance';

const accounts: TrialBalanceAccount[] = [
  { id: 'cash', name: 'Operating Cash', code: '1000', type: 'ASSET' },
  { id: 'prepay', name: 'Guest Pre-payments', code: '2000', type: 'LIABILITY' },
  { id: 'rev', name: 'Rental Income', code: '4000', type: 'REVENUE' },
  { id: 'unused', name: 'Suspense', code: '9999', type: 'SUSPENSE' },
];

const line = (accountId: string, amount: string, isDebit: boolean): TrialBalanceLine => ({ accountId, amount, isDebit });

describe('computeTrialBalance', () => {
  it('returns an empty, balanced report when there are no lines', () => {
    const tb = computeTrialBalance(accounts, []);
    expect(tb.rows).toHaveLength(0);
    expect(tb.totalDebit.toFixed(2)).toBe('0.00');
    expect(tb.totalCredit.toFixed(2)).toBe('0.00');
    expect(tb.isBalanced).toBe(true);
  });

  it('presents each account on its net side and balances to zero', () => {
    // DR Cash 100 / CR Rental Income 100
    const tb = computeTrialBalance(accounts, [line('cash', '100.00', true), line('rev', '100.00', false)]);

    const cash = tb.rows.find((r) => r.accountId === 'cash')!;
    const rev = tb.rows.find((r) => r.accountId === 'rev')!;
    expect(cash.debit.toFixed(2)).toBe('100.00');
    expect(cash.credit.toFixed(2)).toBe('0.00');
    expect(rev.debit.toFixed(2)).toBe('0.00');
    expect(rev.credit.toFixed(2)).toBe('100.00');

    expect(tb.totalDebit.toFixed(2)).toBe('100.00');
    expect(tb.totalCredit.toFixed(2)).toBe('100.00');
    expect(tb.isBalanced).toBe(true);
  });

  it('nets multiple lines within one account before choosing a side', () => {
    // Cash: DR 100 + DR 50 - CR 30 = net DR 120
    const tb = computeTrialBalance(accounts, [
      line('cash', '100.00', true),
      line('cash', '50.00', true),
      line('cash', '30.00', false),
      line('rev', '120.00', false),
    ]);
    const cash = tb.rows.find((r) => r.accountId === 'cash')!;
    expect(cash.debit.toFixed(2)).toBe('120.00');
    expect(cash.credit.toFixed(2)).toBe('0.00');
    expect(tb.isBalanced).toBe(true);
  });

  it('includes an account whose activity nets to zero (shown as 0/0)', () => {
    const tb = computeTrialBalance(accounts, [line('cash', '50.00', true), line('cash', '50.00', false)]);
    const cash = tb.rows.find((r) => r.accountId === 'cash');
    expect(cash).toBeDefined();
    expect(cash!.debit.toFixed(2)).toBe('0.00');
    expect(cash!.credit.toFixed(2)).toBe('0.00');
  });

  it('excludes accounts with no postings', () => {
    const tb = computeTrialBalance(accounts, [line('cash', '10.00', true), line('rev', '10.00', false)]);
    expect(tb.rows.find((r) => r.accountId === 'unused')).toBeUndefined();
  });

  it('sorts rows by account code', () => {
    const tb = computeTrialBalance(accounts, [
      line('rev', '100.00', false),
      line('cash', '100.00', true),
      line('prepay', '40.00', false),
      line('cash', '40.00', true),
    ]);
    expect(tb.rows.map((r) => r.code)).toEqual(['1000', '2000', '4000']);
  });

  it('keeps euro-cent precision (no floating-point drift)', () => {
    const tb = computeTrialBalance(accounts, [
      line('cash', '0.10', true),
      line('cash', '0.20', true),
      line('rev', '0.30', false),
    ]);
    expect(tb.totalDebit.equals(new Decimal('0.30'))).toBe(true);
    expect(tb.isBalanced).toBe(true);
  });

  it('flags an unbalanced set (defensive — should never happen with valid postings)', () => {
    const tb = computeTrialBalance(accounts, [line('cash', '100.00', true), line('rev', '90.00', false)]);
    expect(tb.isBalanced).toBe(false);
    expect(tb.totalDebit.toFixed(2)).toBe('100.00');
    expect(tb.totalCredit.toFixed(2)).toBe('90.00');
  });
});
