/**
 * RAJ-481 — Mobile quick-entry bookkeeping. RED-first.
 *
 * Pure boundary logic behind the mobile /quick page, mirroring the
 * manual-journal-entry.ts pattern: raw form strings in, a typed balanced
 * two-line journal draft (or a human-readable error) out. Income maps
 * DR payment-account / CR revenue-account; expense maps DR expense-account /
 * CR payment-account. Property context travels in the memo (JournalEntry has
 * no propertyId column). Also: monthly income/expense summary aggregation and
 * the guided empty-state resolver.
 */
import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  parseQuickEntry,
  monthlySummary,
  resolveEmptyState,
  type QuickEntryAccount,
  type RawQuickEntry,
} from '@/lib/quick-entry';

const accounts: QuickEntryAccount[] = [
  { id: 'acc-cash', name: 'Cash', type: 'ASSET' },
  { id: 'acc-bank', name: 'Bank', type: 'ASSET' },
  { id: 'acc-rent', name: 'Rental income', type: 'REVENUE' },
  { id: 'acc-repairs', name: 'Repairs', type: 'EXPENSE' },
];

function raw(overrides: Partial<RawQuickEntry> = {}): RawQuickEntry {
  return {
    kind: 'expense',
    amount: '45.50',
    date: '2026-07-13',
    propertyId: 'prop-1',
    propertyName: 'Seaview Flat',
    categoryAccountId: 'acc-repairs',
    paymentAccountId: 'acc-cash',
    memo: 'boiler part',
    ...overrides,
  };
}

describe('parseQuickEntry', () => {
  it('maps an expense to DR category / CR payment, balanced', () => {
    const result = parseQuickEntry(raw(), accounts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { lines } = result.value;
    expect(lines).toHaveLength(2);
    const debit = lines.find(l => l.isDebit)!;
    const credit = lines.find(l => !l.isDebit)!;
    expect(debit.accountId).toBe('acc-repairs');
    expect(credit.accountId).toBe('acc-cash');
    expect(new Decimal(debit.amount as never).eq('45.50')).toBe(true);
    expect(new Decimal(credit.amount as never).eq('45.50')).toBe(true);
  });

  it('maps income to DR payment / CR category', () => {
    const result = parseQuickEntry(raw({ kind: 'income', categoryAccountId: 'acc-rent', paymentAccountId: 'acc-bank' }), accounts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const debit = result.value.lines.find(l => l.isDebit)!;
    const credit = result.value.lines.find(l => !l.isDebit)!;
    expect(debit.accountId).toBe('acc-bank');
    expect(credit.accountId).toBe('acc-rent');
  });

  it('carries the property reference and memo into the entry memo', () => {
    const result = parseQuickEntry(raw(), accounts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.memo).toContain('Seaview Flat');
    expect(result.value.memo).toContain('boiler part');
  });

  it('rejects an income categorised against a non-REVENUE account', () => {
    const result = parseQuickEntry(raw({ kind: 'income', categoryAccountId: 'acc-repairs' }), accounts);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/revenue|income/i);
  });

  it('rejects an expense categorised against a non-EXPENSE account', () => {
    const result = parseQuickEntry(raw({ categoryAccountId: 'acc-rent' }), accounts);
    expect(result.ok).toBe(false);
  });

  it('rejects a payment account that is not an ASSET account', () => {
    const result = parseQuickEntry(raw({ paymentAccountId: 'acc-rent' }), accounts);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/payment/i);
  });

  it('rejects zero, negative, unparseable, and >2dp amounts', () => {
    for (const amount of ['0', '-5', 'abc', '1.999']) {
      const result = parseQuickEntry(raw({ amount }), accounts);
      expect(result.ok, `amount "${amount}" should be rejected`).toBe(false);
    }
  });

  it('rejects a missing property or invalid date', () => {
    expect(parseQuickEntry(raw({ propertyId: '' }), accounts).ok).toBe(false);
    expect(parseQuickEntry(raw({ date: 'not-a-date' }), accounts).ok).toBe(false);
  });

  it('rejects an account id that does not belong to the provided set (tenant isolation)', () => {
    const result = parseQuickEntry(raw({ categoryAccountId: 'someone-elses-account' }), accounts);
    expect(result.ok).toBe(false);
  });
});

describe('monthlySummary', () => {
  const entries = [
    { date: new Date('2026-07-02'), kind: 'income' as const, amount: new Decimal('1200'), propertyId: 'prop-1' },
    { date: new Date('2026-07-15'), kind: 'expense' as const, amount: new Decimal('45.50'), propertyId: 'prop-1' },
    { date: new Date('2026-07-20'), kind: 'expense' as const, amount: new Decimal('100'), propertyId: 'prop-2' },
    { date: new Date('2026-06-28'), kind: 'income' as const, amount: new Decimal('900'), propertyId: 'prop-1' },
  ];

  it('aggregates income, expenses, and net per month', () => {
    const summary = monthlySummary(entries);
    const july = summary.find(m => m.month === '2026-07')!;
    expect(july.income.eq('1200')).toBe(true);
    expect(july.expenses.eq('145.50')).toBe(true);
    expect(july.net.eq('1054.50')).toBe(true);
    const june = summary.find(m => m.month === '2026-06')!;
    expect(june.net.eq('900')).toBe(true);
  });

  it('filters by property when one is given', () => {
    const summary = monthlySummary(entries, 'prop-2');
    expect(summary).toHaveLength(1);
    expect(summary[0].expenses.eq('100')).toBe(true);
  });

  it('returns months sorted most recent first', () => {
    const summary = monthlySummary(entries);
    expect(summary.map(m => m.month)).toEqual(['2026-07', '2026-06']);
  });

  it('returns an empty array for no entries', () => {
    expect(monthlySummary([])).toEqual([]);
  });
});

describe('resolveEmptyState (guided setup)', () => {
  it('guides to add a property first', () => {
    expect(resolveEmptyState({ propertyCount: 0, accountCount: 0, entryCount: 0 })).toEqual({
      step: 'add-property',
      title: expect.stringMatching(/propert/i),
      cta: expect.any(String),
      href: expect.any(String),
    });
  });

  it('guides to set up accounts once a property exists', () => {
    expect(resolveEmptyState({ propertyCount: 1, accountCount: 0, entryCount: 0 })!.step).toBe('setup-accounts');
  });

  it('guides to the first entry once accounts exist', () => {
    expect(resolveEmptyState({ propertyCount: 1, accountCount: 4, entryCount: 0 })!.step).toBe('first-entry');
  });

  it('returns null when there is data (no empty state)', () => {
    expect(resolveEmptyState({ propertyCount: 1, accountCount: 4, entryCount: 12 })).toBeNull();
  });
});
