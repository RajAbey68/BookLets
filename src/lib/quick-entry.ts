import { Decimal } from 'decimal.js';
import type { JournalLineInput } from './types';

/**
 * RAJ-481 — Mobile quick-entry bookkeeping (income/expense in one screen).
 *
 * Pure boundary validator behind the /quick mobile page, mirroring
 * manual-journal-entry.ts: raw form strings in, a typed balanced TWO-LINE
 * journal draft (or a human-readable error) out. Double-entry mapping:
 *
 *   income  → DR payment (ASSET)   / CR category (REVENUE)
 *   expense → DR category (EXPENSE) / CR payment (ASSET)
 *
 * JournalEntry has no propertyId column, so the property reference travels
 * in the memo. LedgerService.postEntry re-validates balance as the authority.
 */

export type QuickEntryKind = 'income' | 'expense';

export interface QuickEntryAccount {
  id: string;
  name: string;
  type: string; // AccountType — ASSET | LIABILITY | EQUITY | REVENUE | EXPENSE | SUSPENSE
}

export interface RawQuickEntry {
  kind: QuickEntryKind;
  amount: string;
  date: string;
  propertyId: string;
  propertyName: string;
  categoryAccountId: string;
  paymentAccountId: string;
  memo?: string;
}

export interface ParsedQuickEntry {
  date: Date;
  memo: string;
  lines: JournalLineInput[];
}

export type QuickEntryResult =
  | { ok: true; value: ParsedQuickEntry }
  | { ok: false; error: string };

const TWO_DP = /^\d+(\.\d{1,2})?$/;

export function parseQuickEntry(
  raw: RawQuickEntry,
  accounts: readonly QuickEntryAccount[],
): QuickEntryResult {
  const date = new Date(raw.date);
  if (!raw.date || Number.isNaN(date.getTime())) {
    return { ok: false, error: 'A valid date is required.' };
  }
  if (!raw.propertyId) {
    return { ok: false, error: 'Choose a property for this entry.' };
  }
  if (!TWO_DP.test(raw.amount.trim())) {
    return { ok: false, error: 'Enter a positive amount with at most 2 decimal places.' };
  }
  const amount = new Decimal(raw.amount.trim());
  if (amount.lte(0)) {
    return { ok: false, error: 'Amount must be greater than zero.' };
  }

  const byId = new Map(accounts.map(a => [a.id, a]));
  const category = byId.get(raw.categoryAccountId);
  const payment = byId.get(raw.paymentAccountId);
  if (!category) return { ok: false, error: 'Choose a category.' };
  if (!payment) return { ok: false, error: 'Choose a payment account.' };

  if (payment.type !== 'ASSET') {
    return { ok: false, error: 'The payment account must be a cash or bank (asset) account.' };
  }
  if (raw.kind === 'income' && category.type !== 'REVENUE') {
    return { ok: false, error: 'Income must be categorised against a revenue account.' };
  }
  if (raw.kind === 'expense' && category.type !== 'EXPENSE') {
    return { ok: false, error: 'An expense must be categorised against an expense account.' };
  }

  const debitAccountId = raw.kind === 'income' ? payment.id : category.id;
  const creditAccountId = raw.kind === 'income' ? category.id : payment.id;

  const memoParts = [`[${raw.propertyName}]`, raw.memo?.trim()].filter(Boolean);

  return {
    ok: true,
    value: {
      date,
      memo: memoParts.join(' '),
      lines: [
        { accountId: debitAccountId, amount, isDebit: true },
        { accountId: creditAccountId, amount, isDebit: false },
      ],
    },
  };
}

// ---------------------------------------------------------------- summary

export interface SummaryEntry {
  date: Date;
  kind: QuickEntryKind;
  amount: Decimal;
  propertyId: string;
}

export interface MonthSummary {
  month: string; // YYYY-MM
  income: Decimal;
  expenses: Decimal;
  net: Decimal;
}

/** Aggregate income/expense per calendar month, most recent first. Optional property filter. */
export function monthlySummary(entries: readonly SummaryEntry[], propertyId?: string): MonthSummary[] {
  const months = new Map<string, { income: Decimal; expenses: Decimal }>();
  for (const entry of entries) {
    if (propertyId && entry.propertyId !== propertyId) continue;
    const month = entry.date.toISOString().slice(0, 7);
    const bucket = months.get(month) ?? { income: new Decimal(0), expenses: new Decimal(0) };
    if (entry.kind === 'income') bucket.income = bucket.income.add(entry.amount);
    else bucket.expenses = bucket.expenses.add(entry.amount);
    months.set(month, bucket);
  }
  return [...months.entries()]
    .map(([month, { income, expenses }]) => ({ month, income, expenses, net: income.sub(expenses) }))
    .sort((a, b) => (a.month < b.month ? 1 : -1));
}

// ---------------------------------------------------------------- empty states

export interface EmptyStateInput {
  propertyCount: number;
  accountCount: number;
  entryCount: number;
}

export interface EmptyState {
  step: 'add-property' | 'setup-accounts' | 'first-entry';
  title: string;
  cta: string;
  href: string;
}

/** Guided setup: the single next step for a fresh workspace, or null when there's data. */
export function resolveEmptyState(input: EmptyStateInput): EmptyState | null {
  if (input.propertyCount === 0) {
    return {
      step: 'add-property',
      title: 'Add your first property',
      cta: 'Add property',
      href: '/properties',
    };
  }
  if (input.accountCount === 0) {
    return {
      step: 'setup-accounts',
      title: 'Set up your accounts',
      cta: 'Set up accounts',
      href: '/ledger',
    };
  }
  if (input.entryCount === 0) {
    return {
      step: 'first-entry',
      title: 'Record your first income or expense',
      cta: 'Quick entry',
      href: '/quick',
    };
  }
  return null;
}
