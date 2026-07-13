/**
 * S11 — pure view-model helpers for the /books page (no prisma imports):
 * POSTED journal entries grouped by calendar month (newest first, capped),
 * with the covering FiscalPeriod rendered as an open/closed badge per month.
 * Shared single authority between books.actions.ts and its unit tests.
 */
import { parseDraftEvidence } from './draft-evidence';

/** /books shows at most this many most-recent months — the page stays bounded. */
export const BOOKS_MONTH_CAP = 6;

/** Structural input shapes — satisfied by the prisma includes in books.actions. */
export interface BooksEntryInput {
  id: string;
  date: Date;
  memo: string | null;
  lines: {
    amount: { toString(): string };
    isDebit: boolean;
    currency: string;
    account: { name: string };
  }[];
}

export interface BooksPeriodInput {
  name: string;
  startDate: Date;
  endDate: Date;
  isClosed: boolean;
  locked: boolean;
}

export interface BookRow {
  id: string;
  /** ISO date string — serializable across the server/client boundary. */
  date: string;
  memo: string | null;
  /** Vendor when the memo encodes one; debit-side account names otherwise. */
  vendorish: string;
  /** Headline amount = sum of the balanced entry's debit lines, 2dp. */
  amount: string;
  currency: string;
}

export interface BooksMonth {
  /** 'YYYY-MM' (UTC). */
  key: string;
  /** e.g. "June 2026". */
  label: string;
  /** Covering FiscalPeriod badge input, or null when no period covers the month. */
  period: { name: string; open: boolean } | null;
  rows: BookRow[];
}

/**
 * UTC start of the month `cap - 1` months before the given date — the query
 * window that yields at most `cap` distinct calendar months.
 */
export function booksWindowStart(newest: Date, cap: number = BOOKS_MONTH_CAP): Date {
  return new Date(Date.UTC(newest.getUTCFullYear(), newest.getUTCMonth() - (cap - 1), 1));
}

/** S1b bridge memo: "AUTOMATED S1b: Receipt <file> — <vendor>". */
const S1B_MEMO = /^AUTOMATED S1b: Receipt .+? — (.+)$/;

/**
 * Best-effort vendor for a row. parseDraftEvidence covers the receipt-OCR and
 * zip-ingest memo formats; the S1b bridge format is matched here (its
 * "unknown vendor" placeholder is not a vendor). Entries without an encoded
 * vendor (manual, bookings) fall back to their debit-side account names.
 */
function vendorishOf(entry: BooksEntryInput): string {
  const parsed = parseDraftEvidence(entry.memo);
  if (parsed.vendor) return parsed.vendor;

  const s1b = (entry.memo ?? '').trim().match(S1B_MEMO);
  if (s1b && s1b[1] !== 'unknown vendor') return s1b[1];

  const debitAccounts = [
    ...new Set(entry.lines.filter((l) => l.isDebit).map((l) => l.account.name)),
  ];
  return debitAccounts.join(', ') || '—';
}

export function toBookRow(entry: BooksEntryInput): BookRow {
  const debitTotal = entry.lines
    .filter((l) => l.isDebit)
    .reduce((sum, l) => sum + Number(l.amount), 0);

  return {
    id: entry.id,
    date: entry.date.toISOString(),
    memo: entry.memo,
    vendorish: vendorishOf(entry),
    amount: debitTotal.toFixed(2),
    currency: entry.lines[0]?.currency ?? 'EUR',
  };
}

/** Same calendar month in UTC — entry dates carry no meaningful time. */
const monthKeyOf = (date: Date) => date.toISOString().slice(0, 7);

const monthLabel = (monthStart: Date) =>
  new Intl.DateTimeFormat('en-IE', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    monthStart,
  );

/** First FiscalPeriod overlapping the month, as {name, open} badge input. */
export function matchFiscalPeriod(
  periods: readonly BooksPeriodInput[],
  monthStart: Date,
  monthEnd: Date,
): BooksMonth['period'] {
  const period = periods.find((p) => p.startDate <= monthEnd && p.endDate >= monthStart);
  if (!period) return null;
  return { name: period.name, open: !period.isClosed && !period.locked };
}

/**
 * Group entries by UTC calendar month, newest month first, capped. Entries
 * arrive date-desc from the query, so per-month row order is preserved; the
 * month keys are re-sorted here so an unsorted caller cannot scramble the view.
 */
export function buildBooksMonths(
  entries: readonly BooksEntryInput[],
  periods: readonly BooksPeriodInput[],
  cap: number = BOOKS_MONTH_CAP,
): BooksMonth[] {
  const byMonth = new Map<string, BooksEntryInput[]>();
  for (const entry of entries) {
    const key = monthKeyOf(entry.date);
    const list = byMonth.get(key) ?? [];
    list.push(entry);
    byMonth.set(key, list);
  }

  const keys = [...byMonth.keys()].sort().reverse().slice(0, cap);
  return keys.map((key) => {
    const [year, month] = key.split('-').map(Number);
    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    // Day 0 of the NEXT month = last instant of this month's final day.
    const monthEnd = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
    return {
      key,
      label: monthLabel(monthStart),
      period: matchFiscalPeriod(periods, monthStart, monthEnd),
      rows: (byMonth.get(key) ?? []).map(toBookRow),
    };
  });
}
