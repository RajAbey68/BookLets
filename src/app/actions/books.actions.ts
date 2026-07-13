'use server';

import { prisma } from '@/lib/prisma';
import { resolveActiveContext } from '@/lib/auth-context';
import {
  BOOKS_MONTH_CAP,
  booksWindowStart,
  buildBooksMonths,
  type BooksMonth,
} from '@/lib/books-view';

export interface BooksViewData {
  months: BooksMonth[];
  /** True when POSTED entries exist before the month window — the page notes the cap. */
  truncated: boolean;
}

const EMPTY_BOOKS_VIEW: { months: BooksMonth[]; truncated: false } = {
  months: [],
  truncated: false,
};

/**
 * S11 — POSTED journal entries for /books, grouped by calendar month (newest
 * first) and capped to the most recent BOOKS_MONTH_CAP months so the page
 * stays bounded regardless of ledger size.
 *
 * Org-scoped via resolveActiveContext (same pattern as approval.actions):
 * the organisation comes from the session, never from client input. The
 * window is anchored on the newest POSTED entry's month, then only entries
 * inside it are loaded; a cheap count detects older entries so the cap note
 * is only shown when something is actually hidden. Degrades to an empty view
 * instead of throwing.
 */
export async function fetchBooksView(): Promise<BooksViewData> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return EMPTY_BOOKS_VIEW;

  const { organizationId } = resolved.context;

  try {
    const newest = await prisma.journalEntry.findFirst({
      where: { organizationId, status: 'POSTED' },
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    if (!newest) return EMPTY_BOOKS_VIEW;

    const windowStart = booksWindowStart(newest.date, BOOKS_MONTH_CAP);
    const [entries, olderCount, periods] = await Promise.all([
      prisma.journalEntry.findMany({
        where: { organizationId, status: 'POSTED', date: { gte: windowStart } },
        include: { lines: { include: { account: true } } },
        // Newest first with the same deterministic tiebreakers as the review
        // queue, so per-month row order is stable across loads.
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      }),
      prisma.journalEntry.count({
        where: { organizationId, status: 'POSTED', date: { lt: windowStart } },
      }),
      prisma.fiscalPeriod.findMany({ where: { organizationId } }),
    ]);

    return { months: buildBooksMonths(entries, periods), truncated: olderCount > 0 };
  } catch (error) {
    console.error('[books.actions] fetchBooksView failed:', error);
    return EMPTY_BOOKS_VIEW;
  }
}
