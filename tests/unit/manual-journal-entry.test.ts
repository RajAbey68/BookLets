/**
 * RAJ-286 [P1-04] — Manual Journal Entry parsing/validation.
 *
 * parseManualJournalEntry is the pure boundary validator behind the
 * /ledger/new form and the createManualJournalEntry server action. It turns
 * raw string form input into a typed, balanced JournalEntryInput or a
 * human-readable error — with zero DB/network dependencies.
 *
 * Balance and account-ownership are enforced HERE (friendly UX errors);
 * LedgerService.postEntry re-validates as the authority (defence in depth).
 */
import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import { parseManualJournalEntry } from '../../src/lib/manual-journal-entry';

const orgAccounts = new Set(['cash', 'revenue', 'fees', 'bank']);

const line = (accountId: string, amount: string, isDebit: boolean) => ({ accountId, amount, isDebit });

describe('parseManualJournalEntry', () => {
  it('rejects a missing or invalid date', () => {
    const bad = parseManualJournalEntry(
      { date: '', lines: [line('cash', '100', true), line('revenue', '100', false)] },
      orgAccounts,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/date/i);

    const bad2 = parseManualJournalEntry(
      { date: 'not-a-date', lines: [line('cash', '100', true), line('revenue', '100', false)] },
      orgAccounts,
    );
    expect(bad2.ok).toBe(false);
  });

  it('requires at least two lines', () => {
    const result = parseManualJournalEntry(
      { date: '2026-07-01', lines: [line('cash', '100', true)] },
      orgAccounts,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/at least two/i);
  });

  it('rejects a line whose account is not in the caller org (tenant isolation)', () => {
    const result = parseManualJournalEntry(
      { date: '2026-07-01', lines: [line('cash', '100', true), line('someone-elses-account', '100', false)] },
      orgAccounts,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found in your organisation/i);
  });

  it('rejects an empty account selection', () => {
    const result = parseManualJournalEntry(
      { date: '2026-07-01', lines: [line('', '100', true), line('revenue', '100', false)] },
      orgAccounts,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/select an account/i);
  });

  it('rejects non-positive or non-numeric amounts', () => {
    for (const amt of ['0', '-5', 'abc', '']) {
      const result = parseManualJournalEntry(
        { date: '2026-07-01', lines: [line('cash', amt, true), line('revenue', '100', false)] },
        orgAccounts,
      );
      expect(result.ok, `amount "${amt}" should be rejected`).toBe(false);
    }
  });

  it('rejects an unbalanced entry and reports the difference', () => {
    const result = parseManualJournalEntry(
      { date: '2026-07-01', lines: [line('cash', '100.00', true), line('revenue', '90.00', false)] },
      orgAccounts,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unbalanced by 10\.00/i);
  });

  it('accepts a balanced two-line entry and returns Decimal amounts', () => {
    const result = parseManualJournalEntry(
      { date: '2026-07-01', memo: '  opening cash  ', lines: [line('cash', '500.00', true), line('revenue', '500.00', false)] },
      orgAccounts,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.date).toBeInstanceOf(Date);
      expect(result.value.memo).toBe('opening cash'); // trimmed
      expect(result.value.lines).toHaveLength(2);
      expect(result.value.lines[0].amount).toBeInstanceOf(Decimal);
      expect((result.value.lines[0].amount as Decimal).toFixed(2)).toBe('500.00');
    }
  });

  it('accepts a balanced three-line split', () => {
    const result = parseManualJournalEntry(
      {
        date: '2026-07-01',
        lines: [line('cash', '1000.00', true), line('revenue', '600.00', false), line('fees', '400.00', false)],
      },
      orgAccounts,
    );
    expect(result.ok).toBe(true);
  });

  it('balances with euro-cent precision (no floating-point drift)', () => {
    const result = parseManualJournalEntry(
      {
        date: '2026-07-01',
        lines: [line('cash', '0.10', true), line('bank', '0.20', true), line('revenue', '0.30', false)],
      },
      orgAccounts,
    );
    expect(result.ok).toBe(true);
  });

  it('treats a blank memo as undefined', () => {
    const result = parseManualJournalEntry(
      { date: '2026-07-01', memo: '   ', lines: [line('cash', '5', true), line('revenue', '5', false)] },
      orgAccounts,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.memo).toBeUndefined();
  });
});
