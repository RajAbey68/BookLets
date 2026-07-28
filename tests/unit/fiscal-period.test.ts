/**
 * Fiscal periods — pure core.
 *
 * A fiscal period is the accounting control that lets a stretch of the books
 * be closed and locked so posted history can no longer be edited.
 * LedgerService.checkFiscalPeriod refuses to post ANY entry whose date is not
 * covered by an open period, and until now nothing in the running application
 * could create one (only prisma/seed.ts, which must never touch production).
 * A freshly deployed organisation could therefore not import a single receipt.
 *
 * This suite pins the rules that make operator-created periods safe:
 *   - coverage is decided EXACTLY the way checkFiscalPeriod decides it, so the
 *     pre-flight check and the ledger can never disagree;
 *   - periods may not overlap — overlapping periods make "which period covers
 *     this date" ambiguous and would let an open period shadow a closed one,
 *     which is precisely how the close control gets destroyed;
 *   - a new period is normalised to whole UTC days so the last day of a period
 *     is genuinely inclusive;
 *   - every rejection is phrased for someone who does not know what a fiscal
 *     period is.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_PERIOD_DAYS,
  MAX_PERIOD_NAME_LENGTH,
  NO_OPEN_PERIOD_MESSAGE,
  dateOutsidePeriodsMessage,
  findOpenPeriodForDate,
  formatPeriodDate,
  hasOpenPeriodCovering,
  isPeriodOpen,
  periodCoversDate,
  periodsOverlap,
  suggestCurrentYearPeriod,
  validateNewPeriod,
  type PeriodWindow,
} from '../../src/lib/fiscal-period';

const fy26: PeriodWindow = {
  id: 'fp-1',
  name: 'FY 2026',
  startDate: new Date('2026-01-01T00:00:00.000Z'),
  endDate: new Date('2026-12-31T23:59:59.999Z'),
  isClosed: false,
  locked: false,
};

describe('isPeriodOpen', () => {
  it('is open only when neither closed nor locked', () => {
    expect(isPeriodOpen(fy26)).toBe(true);
    expect(isPeriodOpen({ ...fy26, isClosed: true })).toBe(false);
    expect(isPeriodOpen({ ...fy26, locked: true })).toBe(false);
    expect(isPeriodOpen({ ...fy26, isClosed: true, locked: true })).toBe(false);
  });
});

describe('periodCoversDate', () => {
  it('is inclusive at both ends, to the millisecond the ledger compares on', () => {
    expect(periodCoversDate(fy26, new Date('2026-01-01T00:00:00.000Z'))).toBe(true);
    expect(periodCoversDate(fy26, new Date('2026-07-12T09:30:00.000Z'))).toBe(true);
    expect(periodCoversDate(fy26, new Date('2026-12-31T23:59:59.999Z'))).toBe(true);
  });

  it('excludes dates on either side', () => {
    expect(periodCoversDate(fy26, new Date('2025-12-31T23:59:59.999Z'))).toBe(false);
    expect(periodCoversDate(fy26, new Date('2027-01-01T00:00:00.000Z'))).toBe(false);
  });

  it('covers a date regardless of the period status — status is a separate question', () => {
    const closed: PeriodWindow = { ...fy26, isClosed: true };
    expect(periodCoversDate(closed, new Date('2026-07-12T00:00:00Z'))).toBe(true);
  });
});

describe('findOpenPeriodForDate / hasOpenPeriodCovering', () => {
  const closed2025: PeriodWindow = {
    id: 'fp-0',
    name: 'FY 2025',
    startDate: new Date('2025-01-01T00:00:00.000Z'),
    endDate: new Date('2025-12-31T23:59:59.999Z'),
    isClosed: true,
    locked: false,
  };

  it('returns the covering OPEN period', () => {
    expect(findOpenPeriodForDate([closed2025, fy26], new Date('2026-07-12T00:00:00Z'))?.name).toBe(
      'FY 2026',
    );
  });

  it('never returns a closed or locked period, even when it covers the date', () => {
    expect(findOpenPeriodForDate([closed2025], new Date('2025-06-01T00:00:00Z'))).toBeNull();
    expect(
      findOpenPeriodForDate([{ ...fy26, locked: true }], new Date('2026-07-12T00:00:00Z')),
    ).toBeNull();
  });

  it('returns null when nothing covers the date at all — the production blocker', () => {
    expect(hasOpenPeriodCovering([], new Date('2026-07-12T00:00:00Z'))).toBe(false);
    expect(hasOpenPeriodCovering([closed2025], new Date('2026-07-12T00:00:00Z'))).toBe(false);
    expect(hasOpenPeriodCovering([fy26], new Date('2026-07-12T00:00:00Z'))).toBe(true);
  });
});

describe('periodsOverlap', () => {
  const a = { startDate: new Date('2026-01-01T00:00:00Z'), endDate: new Date('2026-06-30T23:59:59.999Z') };
  it('detects any shared day, in either direction', () => {
    expect(
      periodsOverlap(a, {
        startDate: new Date('2026-06-30T00:00:00Z'),
        endDate: new Date('2026-12-31T23:59:59.999Z'),
      }),
    ).toBe(true);
    expect(
      periodsOverlap(a, {
        startDate: new Date('2025-01-01T00:00:00Z'),
        endDate: new Date('2026-01-01T00:00:00.000Z'),
      }),
    ).toBe(true);
  });

  it('adjacent periods do not overlap', () => {
    expect(
      periodsOverlap(a, {
        startDate: new Date('2026-07-01T00:00:00.000Z'),
        endDate: new Date('2026-12-31T23:59:59.999Z'),
      }),
    ).toBe(false);
  });
});

describe('validateNewPeriod', () => {
  const ok = { name: 'FY 2026', startDate: '2026-01-01', endDate: '2026-12-31' };

  it('normalises to whole UTC days so the last day is genuinely inclusive', () => {
    const result = validateNewPeriod(ok, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.startDate.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(result.value.endDate.toISOString()).toBe('2026-12-31T23:59:59.999Z');
    // A receipt dated late on the final day must be inside the period.
    expect(
      periodCoversDate(
        { ...fy26, ...result.value },
        new Date('2026-12-31T18:45:00.000Z'),
      ),
    ).toBe(true);
  });

  it('trims the name and rejects an empty one in plain language', () => {
    const trimmed = validateNewPeriod({ ...ok, name: '  FY 2026  ' }, []);
    expect(trimmed.ok && trimmed.value.name).toBe('FY 2026');

    const blank = validateNewPeriod({ ...ok, name: '   ' }, []);
    expect(blank.ok).toBe(false);
    expect(blank.ok === false && blank.error).toMatch(/name/i);
  });

  it('rejects an over-long name', () => {
    const result = validateNewPeriod({ ...ok, name: 'x'.repeat(MAX_PERIOD_NAME_LENGTH + 1) }, []);
    expect(result.ok).toBe(false);
  });

  it('rejects unparseable or missing dates without mentioning code', () => {
    for (const bad of ['', 'not-a-date', '2026-13-01', '31/12/2026']) {
      const result = validateNewPeriod({ ...ok, startDate: bad }, []);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/date/i);
      expect(result.ok === false && result.error).not.toMatch(/NaN|Invalid Date|parse/i);
    }
  });

  it('rejects an end date before the start date', () => {
    const result = validateNewPeriod({ ...ok, startDate: '2026-12-31', endDate: '2026-01-01' }, []);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/end date/i);
  });

  it('accepts a single-day period', () => {
    expect(validateNewPeriod({ ...ok, startDate: '2026-07-12', endDate: '2026-07-12' }, []).ok).toBe(
      true,
    );
  });

  it('refuses an absurdly long period — "open everything forever" is not a period', () => {
    const result = validateNewPeriod({ ...ok, startDate: '2000-01-01', endDate: '2099-12-31' }, []);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/longer than/i);
    // The boundary itself is allowed.
    const boundary = new Date(Date.UTC(2026, 0, 1) + (MAX_PERIOD_DAYS - 1) * 86_400_000);
    expect(
      validateNewPeriod(
        { ...ok, startDate: '2026-01-01', endDate: boundary.toISOString().slice(0, 10) },
        [],
      ).ok,
    ).toBe(true);
  });

  it('refuses to overlap an existing period, naming it', () => {
    const result = validateNewPeriod({ ...ok, startDate: '2026-06-01', endDate: '2026-07-31' }, [
      fy26,
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('FY 2026');
  });

  it('refuses to overlap a CLOSED period — a closed period can never be reopened this way', () => {
    const closed = { ...fy26, isClosed: true, closedAt: new Date() };
    const result = validateNewPeriod({ ...ok, startDate: '2026-07-01', endDate: '2026-07-31' }, [
      closed,
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('FY 2026');
  });

  it('allows a period that merely sits next to an existing one', () => {
    expect(
      validateNewPeriod({ name: 'FY 2027', startDate: '2027-01-01', endDate: '2027-12-31' }, [fy26])
        .ok,
    ).toBe(true);
  });
});

describe('suggestCurrentYearPeriod', () => {
  it('offers the calendar year the operator is standing in', () => {
    expect(suggestCurrentYearPeriod(new Date('2026-07-28T10:00:00Z'))).toEqual({
      name: 'FY 2026',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
  });

  it('is always valid against an empty book — one click must actually work', () => {
    const suggestion = suggestCurrentYearPeriod(new Date('2026-07-28T10:00:00Z'));
    expect(validateNewPeriod(suggestion, []).ok).toBe(true);
  });
});

describe('operator-facing copy', () => {
  it('tells a non-accountant what happened and what to do, with no jargon left bare', () => {
    expect(NO_OPEN_PERIOD_MESSAGE).toMatch(/accounting period/i);
    expect(NO_OPEN_PERIOD_MESSAGE).toMatch(/Accounting periods page/i);

    const message = dateOutsidePeriodsMessage(new Date('2026-07-12T00:00:00Z'));
    expect(message).toContain('12 July 2026');
    expect(message).toMatch(/Accounting periods page/i);
  });

  it('formats dates the way a person writes them, not the way a machine does', () => {
    expect(formatPeriodDate(new Date('2026-07-12T00:00:00Z'))).toBe('12 July 2026');
    expect(formatPeriodDate(new Date('2026-12-31T23:59:59.999Z'))).toBe('31 December 2026');
  });
});
