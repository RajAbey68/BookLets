/**
 * Ko Lake reconciliation pilot — deterministic matcher core (RAJ: BookLets v1).
 *
 * Rules under test:
 *  - Money is compared in integer minor units derived via decimal.js — never
 *    binary floats (P4/TDD + "amount in minor units, never float").
 *  - A payout matches a booking iff the minor-unit amounts are equal AND the
 *    payout date is within ±3 calendar days (UTC) of the booking check-out.
 *  - Exactly one candidate → matched. Two or more → ambiguous (LLM territory).
 *    Zero → unmatched exception. A booking is consumed by at most one payout.
 *  - Draft journal pairs must balance: debits == credits or the builder throws.
 */
import { describe, it, expect } from 'vitest';
import {
  toMinorUnits,
  reconcile,
  buildDraftJournalInput,
  assertBalanced,
  formatDigest,
  type PayoutRow,
  type BookingRow,
} from '../../src/lib/reconciliation';

const payout = (over: Partial<PayoutRow> = {}): PayoutRow => ({
  id: 'po-1',
  date: new Date('2026-07-01T09:30:00Z'),
  amount: '1250.00',
  reference: 'HSBC-771',
  ...over,
});

const booking = (over: Partial<BookingRow> = {}): BookingRow => ({
  id: 'bk-1',
  checkOut: new Date('2026-06-30T00:00:00Z'),
  totalAmount: '1250.00',
  ...over,
});

describe('toMinorUnits', () => {
  it('converts a 2dp decimal string to integer minor units exactly', () => {
    expect(toMinorUnits('1250.00')).toBe(125000);
    expect(toMinorUnits('0.01')).toBe(1);
    expect(toMinorUnits('290')).toBe(29000);
  });

  it('is exact where binary floats are not (0.29 * 100 !== 29 in FP)', () => {
    // 0.29 * 100 === 28.999999999999996 in IEEE-754 — the classic trap.
    expect(toMinorUnits('0.29')).toBe(29);
    expect(toMinorUnits('19.99')).toBe(1999);
  });

  it('rejects amounts with sub-minor-unit precision', () => {
    expect(() => toMinorUnits('10.005')).toThrow(/minor unit/i);
  });

  it('rejects non-numeric and non-finite input', () => {
    expect(() => toMinorUnits('not-money')).toThrow();
  });
});

describe('reconcile — deterministic pass', () => {
  it('matches a payout to the single booking with equal amount inside the window', () => {
    const result = reconcile([payout()], [booking()]);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]).toMatchObject({ payoutId: 'po-1', bookingId: 'bk-1' });
    expect(result.ambiguous).toHaveLength(0);
    expect(result.unmatched).toHaveLength(0);
  });

  it('matches at exactly 3 calendar days distance (inclusive boundary)', () => {
    const result = reconcile(
      [payout({ date: new Date('2026-07-03T23:59:00Z') })],
      [booking({ checkOut: new Date('2026-06-30T01:00:00Z') })]
    );
    expect(result.matched).toHaveLength(1);
  });

  it('does not match 4 calendar days out', () => {
    const result = reconcile(
      [payout({ date: new Date('2026-07-04T00:01:00Z') })],
      [booking({ checkOut: new Date('2026-06-30T23:00:00Z') })]
    );
    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(1);
  });

  it('does not match when amounts differ by one minor unit', () => {
    const result = reconcile([payout({ amount: '1250.01' })], [booking()]);
    expect(result.matched).toHaveLength(0);
    expect(result.unmatched.map((u) => u.payout.id)).toEqual(['po-1']);
  });

  it('flags two equal-amount candidate bookings as ambiguous, with candidates listed', () => {
    const result = reconcile(
      [payout()],
      [booking(), booking({ id: 'bk-2', checkOut: new Date('2026-07-02T00:00:00Z') })]
    );
    expect(result.matched).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0].payout.id).toBe('po-1');
    expect(result.ambiguous[0].candidates.map((c) => c.id).sort()).toEqual(['bk-1', 'bk-2']);
  });

  it('consumes a booking at most once — second payout for it goes to unmatched', () => {
    const result = reconcile(
      [payout(), payout({ id: 'po-2', date: new Date('2026-07-02T00:00:00Z') })],
      [booking()]
    );
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].payoutId).toBe('po-1');
    expect(result.unmatched.map((u) => u.payout.id)).toEqual(['po-2']);
  });

  it('processes payouts in date order regardless of input order', () => {
    const early = payout({ id: 'po-early', date: new Date('2026-06-29T00:00:00Z') });
    const late = payout({ id: 'po-late', date: new Date('2026-07-02T00:00:00Z') });
    const result = reconcile([late, early], [booking()]);
    expect(result.matched[0].payoutId).toBe('po-early');
  });
});

describe('buildDraftJournalInput', () => {
  const accounts = { bankAccountId: 'acct-bank', clearingAccountId: 'acct-clearing' };

  it('builds a balanced DRAFT entry: DR bank / CR clearing for the payout amount', () => {
    const match = { payoutId: 'po-1', bookingId: 'bk-1', amount: '1250.00', date: new Date('2026-07-01T00:00:00Z') };
    const input = buildDraftJournalInput('org-1', match, accounts);

    expect(input.status).toBe('DRAFT');
    expect(input.organizationId).toBe('org-1');
    expect(input.source).toBe('reconciliation');
    expect(input.sourceId).toBe('po-1');
    expect(input.lines).toHaveLength(2);

    const debit = input.lines.find((l) => l.isDebit)!;
    const credit = input.lines.find((l) => !l.isDebit)!;
    expect(debit.accountId).toBe('acct-bank');
    expect(credit.accountId).toBe('acct-clearing');
    expect(debit.amount.toString()).toBe('1250.00');
    expect(credit.amount.toString()).toBe('1250.00');
  });

  it('mentions the booking in the memo for the human reviewer', () => {
    const match = { payoutId: 'po-1', bookingId: 'bk-9', amount: '10.00', date: new Date('2026-07-01T00:00:00Z') };
    expect(buildDraftJournalInput('org-1', match, accounts).memo).toContain('bk-9');
  });
});

describe('assertBalanced', () => {
  it('passes when debits equal credits', () => {
    expect(() =>
      assertBalanced([
        { accountId: 'a', amount: '100.00', isDebit: true },
        { accountId: 'b', amount: '100.00', isDebit: false },
      ])
    ).not.toThrow();
  });

  it('throws when debits != credits', () => {
    expect(() =>
      assertBalanced([
        { accountId: 'a', amount: '100.00', isDebit: true },
        { accountId: 'b', amount: '99.99', isDebit: false },
      ])
    ).toThrow(/debits.*credits|unbalanced/i);
  });
});

describe('formatDigest', () => {
  it('emits a single line with counts and exception ids', () => {
    const digest = formatDigest({
      runDate: new Date('2026-07-04T02:00:00Z'),
      matched: 12,
      ambiguousResolved: 2,
      exceptions: [
        { payoutId: 'po-7', amount: '410.00', reason: 'no booking within window' },
        { payoutId: 'po-9', amount: '95.50', reason: 'LLM declined' },
      ],
    });
    expect(digest).not.toContain('\n');
    expect(digest).toContain('2026-07-04');
    expect(digest).toContain('matched=12');
    expect(digest).toContain('llm_resolved=2');
    expect(digest).toContain('exceptions=2');
    expect(digest).toContain('po-7');
    expect(digest).toContain('po-9');
  });

  it('reports a clean run without an exception tail', () => {
    const digest = formatDigest({
      runDate: new Date('2026-07-04T02:00:00Z'),
      matched: 5,
      ambiguousResolved: 0,
      exceptions: [],
    });
    expect(digest).toContain('exceptions=0');
    expect(digest).not.toContain('|  |');
  });
});
