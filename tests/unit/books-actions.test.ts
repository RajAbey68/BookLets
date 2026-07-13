/**
 * S11 — /books data layer.
 *
 *  - fetchBooksView (books.actions.ts, mocked Prisma): org-scoped and
 *    POSTED-only in every query, deterministic newest-first ordering, the
 *    6-month window anchored on the newest POSTED entry, the truncation flag,
 *    and graceful degradation (unauthenticated / DB down → empty view);
 *  - buildBooksMonths & friends (books-view.ts, pure): month grouping newest
 *    first, the month cap, the headline amount (sum of debit lines),
 *    vendor-ish extraction per memo format, and FiscalPeriod badge matching.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BOOKS_MONTH_CAP,
  booksWindowStart,
  buildBooksMonths,
  matchFiscalPeriod,
  toBookRow,
  type BooksEntryInput,
  type BooksPeriodInput,
} from '../../src/lib/books-view';

const ORG = 'org-1';

function entry(id: string, date: string, memo: string | null, amount = '100.00'): BooksEntryInput {
  return {
    id,
    date: new Date(date),
    memo,
    lines: [
      { amount, isDebit: true, currency: 'EUR', account: { name: 'Repairs' } },
      { amount, isDebit: false, currency: 'EUR', account: { name: 'Cash' } },
    ],
  };
}

const FY2026: BooksPeriodInput = {
  name: 'FY2026',
  startDate: new Date('2026-01-01T00:00:00Z'),
  endDate: new Date('2026-12-31T23:59:59Z'),
  isClosed: false,
  locked: false,
};

// ─── pure view-model helpers (books-view.ts) ─────────────────────────────────

describe('buildBooksMonths', () => {
  it('groups entries by UTC calendar month, newest month first, regardless of input order', () => {
    const months = buildBooksMonths(
      [
        entry('je-april', '2026-04-10T00:00:00Z', 'April'),
        entry('je-june', '2026-06-20T00:00:00Z', 'June'),
        entry('je-may', '2026-05-05T00:00:00Z', 'May'),
      ],
      [FY2026],
    );

    expect(months.map((m) => m.key)).toEqual(['2026-06', '2026-05', '2026-04']);
    expect(months.map((m) => m.label)).toEqual(['June 2026', 'May 2026', 'April 2026']);
    expect(months[0].rows.map((r) => r.id)).toEqual(['je-june']);
  });

  it(`caps the view at the ${BOOKS_MONTH_CAP} most recent months`, () => {
    const entries = Array.from({ length: 8 }, (_, i) =>
      entry(`je-${i}`, `2026-0${8 - i}-15T00:00:00Z`, `Month ${8 - i}`),
    );
    const months = buildBooksMonths(entries, [FY2026]);

    expect(months).toHaveLength(BOOKS_MONTH_CAP);
    // Newest 6 of Aug..Jan = Aug..Mar; Feb and Jan fall off the end.
    expect(months[0].key).toBe('2026-08');
    expect(months[months.length - 1].key).toBe('2026-03');
  });

  it('preserves the (already date-desc) row order inside each month', () => {
    const months = buildBooksMonths(
      [
        entry('je-later', '2026-06-25T00:00:00Z', 'later'),
        entry('je-earlier', '2026-06-05T00:00:00Z', 'earlier'),
      ],
      [FY2026],
    );

    expect(months[0].rows.map((r) => r.id)).toEqual(['je-later', 'je-earlier']);
  });

  it('labels each month with its covering FiscalPeriod and open/closed state', () => {
    const closedFy: BooksPeriodInput = { ...FY2026, name: 'FY2026', isClosed: true };
    const months = buildBooksMonths([entry('je-1', '2026-06-20T00:00:00Z', 'x')], [closedFy]);

    expect(months[0].period).toEqual({ name: 'FY2026', open: false });
  });
});

describe('toBookRow', () => {
  it('sums only the debit lines into the headline amount and carries the line currency', () => {
    const row = toBookRow({
      id: 'je-1',
      date: new Date('2026-06-20T00:00:00Z'),
      memo: 'multi-line',
      lines: [
        { amount: '60.00', isDebit: true, currency: 'LKR', account: { name: 'Repairs' } },
        { amount: '40.00', isDebit: true, currency: 'LKR', account: { name: 'Supplies' } },
        { amount: '100.00', isDebit: false, currency: 'LKR', account: { name: 'Cash' } },
      ],
    });

    expect(row.amount).toBe('100.00');
    expect(row.currency).toBe('LKR');
  });

  it('extracts vendor-ish info per memo format, falling back to debit account names', () => {
    const vendorOf = (memo: string | null) =>
      toBookRow(entry('je-x', '2026-06-01T00:00:00Z', memo)).vendorish;

    // The three automated memo formats in the codebase:
    expect(vendorOf('AUTOMATED: Receipt for Colombo Hardware')).toBe('Colombo Hardware');
    expect(vendorOf('ZIP-INGEST: Keells Super [Groceries] — IMG-1.jpg')).toBe('Keells Super');
    expect(vendorOf('AUTOMATED S1b: Receipt r1.jpg — Cargills')).toBe('Cargills');
    // S1b's placeholder is not a vendor; manual memos have no vendor either.
    expect(vendorOf('AUTOMATED S1b: Receipt r2.jpg — unknown vendor')).toBe('Repairs');
    expect(vendorOf('Manual correction entry')).toBe('Repairs');
    expect(vendorOf(null)).toBe('Repairs');
  });
});

describe('matchFiscalPeriod / booksWindowStart', () => {
  it('matches a period that merely overlaps the month and reports locked as closed', () => {
    const lockedFy: BooksPeriodInput = { ...FY2026, locked: true };
    const monthStart = new Date('2026-06-01T00:00:00Z');
    const monthEnd = new Date('2026-06-30T23:59:59.999Z');

    expect(matchFiscalPeriod([lockedFy], monthStart, monthEnd)).toEqual({
      name: 'FY2026',
      open: false,
    });
    expect(matchFiscalPeriod([], monthStart, monthEnd)).toBeNull();
  });

  it('computes the UTC month window start cap-1 months back, across year boundaries', () => {
    expect(booksWindowStart(new Date('2026-06-20T12:00:00Z'), 6)).toEqual(
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(booksWindowStart(new Date('2026-02-10T00:00:00Z'), 6)).toEqual(
      new Date('2025-09-01T00:00:00Z'),
    );
  });
});

// ─── fetchBooksView (books.actions.ts) — mocked Prisma ───────────────────────

interface SetupOverrides {
  unauthenticated?: boolean;
  noEntries?: boolean;
  dbError?: boolean;
  olderCount?: number;
}

function setup(overrides: SetupOverrides = {}) {
  const newestDate = new Date('2026-06-20T00:00:00Z');
  const posted = [
    { ...entry('je-june', '2026-06-20T00:00:00Z', 'June expense'), status: 'POSTED' },
    { ...entry('je-may', '2026-05-05T00:00:00Z', 'May expense'), status: 'POSTED' },
  ];
  const prisma = {
    journalEntry: {
      findFirst: overrides.dbError
        ? vi.fn().mockRejectedValue(new Error('db down'))
        : vi.fn().mockResolvedValue(overrides.noEntries ? null : { date: newestDate }),
      findMany: vi.fn().mockResolvedValue(posted),
      count: vi.fn().mockResolvedValue(overrides.olderCount ?? 0),
    },
    fiscalPeriod: { findMany: vi.fn().mockResolvedValue([FY2026]) },
  };
  vi.doMock('../../src/lib/prisma', () => ({ prisma, setRlsOrgContext: vi.fn() }));
  vi.doMock('../../src/lib/auth-context', () => ({
    resolveActiveContext: vi.fn().mockResolvedValue(
      overrides.unauthenticated
        ? { ok: false, error: 'Not authenticated. Sign in to continue.' }
        : {
            ok: true,
            context: { organizationId: ORG, organizationName: 'Test Org', userId: 'u-1', role: 'OWNER' },
          },
    ),
  }));
  return { prisma };
}

async function importBooks() {
  return import('../../src/app/actions/books.actions');
}

beforeEach(() => vi.resetModules());

describe('fetchBooksView', () => {
  it('loads POSTED entries org-scoped inside the month window with deterministic newest-first ordering', async () => {
    const { prisma } = setup();
    const { fetchBooksView } = await importBooks();

    const view = await fetchBooksView();

    const windowStart = new Date('2026-01-01T00:00:00Z');
    expect(prisma.journalEntry.findFirst).toHaveBeenCalledWith({
      where: { organizationId: ORG, status: 'POSTED' },
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    expect(prisma.journalEntry.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, status: 'POSTED', date: { gte: windowStart } },
      include: { lines: { include: { account: true } } },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(prisma.fiscalPeriod.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG },
    });
    expect(view.months.map((m) => m.key)).toEqual(['2026-06', '2026-05']);
    expect(view.months[0].period).toEqual({ name: 'FY2026', open: true });
  });

  it('flags truncation only when POSTED entries exist before the window', async () => {
    const { prisma } = setup({ olderCount: 3 });
    const { fetchBooksView } = await importBooks();

    const view = await fetchBooksView();

    expect(prisma.journalEntry.count).toHaveBeenCalledWith({
      where: { organizationId: ORG, status: 'POSTED', date: { lt: new Date('2026-01-01T00:00:00Z') } },
    });
    expect(view.truncated).toBe(true);
  });

  it('returns an empty view when nothing is POSTED yet, without loading entries', async () => {
    const { prisma } = setup({ noEntries: true });
    const { fetchBooksView } = await importBooks();

    const view = await fetchBooksView();

    expect(view).toEqual({ months: [], truncated: false });
    expect(prisma.journalEntry.findMany).not.toHaveBeenCalled();
  });

  it('returns an empty view when unauthenticated, touching nothing', async () => {
    const { prisma } = setup({ unauthenticated: true });
    const { fetchBooksView } = await importBooks();

    const view = await fetchBooksView();

    expect(view).toEqual({ months: [], truncated: false });
    expect(prisma.journalEntry.findFirst).not.toHaveBeenCalled();
  });

  it('degrades to an empty view instead of throwing when the DB is down', async () => {
    setup({ dbError: true });
    const { fetchBooksView } = await importBooks();

    await expect(fetchBooksView()).resolves.toEqual({ months: [], truncated: false });
  });
});
