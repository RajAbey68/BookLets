/**
 * RAJ-283 [P1-01] — Account balance rollup logic.
 *
 * AccountService.rollup is a pure function: given a flat list of accounts
 * with their OWN balances and parentId links, it returns each account's own
 * balance plus the sum of ALL descendant balances. This is the arithmetic
 * behind P&L / balance-sheet rollup reporting (RAJ-289/290).
 *
 * Pure — no DB, no network. Uses Decimal to preserve ledger precision.
 */
import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import { AccountService, type AccountNode } from '../../src/lib/account.service';

describe('AccountService.rollup', () => {
  it('returns own balance for a leaf account with no children', () => {
    const nodes: AccountNode[] = [
      { id: 'a', parentId: null, balance: new Decimal('100.00') },
    ];
    const result = AccountService.rollup(nodes);
    expect(result.get('a')!.rolledUpBalance.toFixed(2)).toBe('100.00');
    expect(result.get('a')!.ownBalance.toFixed(2)).toBe('100.00');
  });

  it('aggregates two children into their parent', () => {
    // 4000 Rental Income (own 0) ← 4100 Airbnb (600) + 4200 Direct (400)
    const nodes: AccountNode[] = [
      { id: 'parent', parentId: null, balance: new Decimal('0') },
      { id: 'airbnb', parentId: 'parent', balance: new Decimal('600.00') },
      { id: 'direct', parentId: 'parent', balance: new Decimal('400.00') },
    ];
    const result = AccountService.rollup(nodes);
    expect(result.get('parent')!.rolledUpBalance.toFixed(2)).toBe('1000.00');
    // children roll up only to their own balance
    expect(result.get('airbnb')!.rolledUpBalance.toFixed(2)).toBe('600.00');
  });

  it('rolls up across multiple levels (grandparent includes grandchild)', () => {
    const nodes: AccountNode[] = [
      { id: 'total-expenses', parentId: null, balance: new Decimal('0') },
      { id: 'operating', parentId: 'total-expenses', balance: new Decimal('50.00') },
      { id: 'cleaning', parentId: 'operating', balance: new Decimal('300.00') },
    ];
    const result = AccountService.rollup(nodes);
    expect(result.get('operating')!.rolledUpBalance.toFixed(2)).toBe('350.00');
    expect(result.get('total-expenses')!.rolledUpBalance.toFixed(2)).toBe('350.00');
  });

  it('preserves own balance separately from the rolled-up total', () => {
    const nodes: AccountNode[] = [
      { id: 'parent', parentId: null, balance: new Decimal('10.00') },
      { id: 'child', parentId: 'parent', balance: new Decimal('5.00') },
    ];
    const result = AccountService.rollup(nodes);
    expect(result.get('parent')!.ownBalance.toFixed(2)).toBe('10.00');
    expect(result.get('parent')!.rolledUpBalance.toFixed(2)).toBe('15.00');
  });

  it('handles euro-cent precision without floating-point drift', () => {
    const nodes: AccountNode[] = [
      { id: 'parent', parentId: null, balance: new Decimal('0') },
      { id: 'c1', parentId: 'parent', balance: new Decimal('0.10') },
      { id: 'c2', parentId: 'parent', balance: new Decimal('0.20') },
    ];
    const result = AccountService.rollup(nodes);
    expect(result.get('parent')!.rolledUpBalance.equals(new Decimal('0.30'))).toBe(true);
  });

  it('accepts number and string balances, coercing to Decimal', () => {
    const nodes: AccountNode[] = [
      { id: 'parent', parentId: null, balance: 0 },
      { id: 'c1', parentId: 'parent', balance: 600 },
      { id: 'c2', parentId: 'parent', balance: '400.00' },
    ];
    const result = AccountService.rollup(nodes);
    expect(result.get('parent')!.rolledUpBalance.toFixed(2)).toBe('1000.00');
  });

  it('treats a parentId pointing at an unknown account as a root', () => {
    // Defensive: orphaned FK should not crash rollup.
    const nodes: AccountNode[] = [
      { id: 'orphan', parentId: 'ghost', balance: new Decimal('42.00') },
    ];
    const result = AccountService.rollup(nodes);
    expect(result.get('orphan')!.rolledUpBalance.toFixed(2)).toBe('42.00');
  });

  it('throws on a cycle rather than looping forever', () => {
    const nodes: AccountNode[] = [
      { id: 'a', parentId: 'b', balance: new Decimal('1') },
      { id: 'b', parentId: 'a', balance: new Decimal('1') },
    ];
    expect(() => AccountService.rollup(nodes)).toThrow(/cycle/i);
  });
});
