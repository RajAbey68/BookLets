/**
 * Fiscal periods — pure core (no prisma, no network, no clock of its own).
 *
 * WHAT A FISCAL PERIOD IS FOR
 * It is an accounting CONTROL, not a formality. Every stretch of the books
 * belongs to exactly one period; when the work for that stretch is finished
 * the period is closed, and from then on nothing may be posted into it. That
 * is what makes a set of books trustworthy: last month's figures cannot
 * quietly change after they have been reported.
 *
 * LedgerService.checkFiscalPeriod enforces it — an entry whose date is not
 * covered by an OPEN (not closed, not locked) period is refused. Until now the
 * only code in the repository that could CREATE a period was prisma/seed.ts,
 * which also seeds demo properties and must never run against production, so a
 * freshly deployed organisation could not import a single receipt.
 *
 * This module holds the rules; all IO lives in
 * src/app/actions/fiscal-period.actions.ts.
 *
 * TWO INVARIANTS ARE LOAD-BEARING
 *
 * 1. Coverage is decided EXACTLY as checkFiscalPeriod decides it —
 *    startDate <= date <= endDate, plus isClosed=false and locked=false. Any
 *    drift between the pre-flight check and the ledger reintroduces the bug
 *    this module exists to remove (an import that passes the check and then
 *    fails at the post, after the OCR money is spent).
 *
 * 2. Periods MUST NOT OVERLAP. checkFiscalPeriod uses findFirst, so with two
 *    periods covering one date the answer depends on row order — and an
 *    overlapping OPEN period would let entries be posted into the date range
 *    of a CLOSED one. Overlap is therefore refused at creation: it is the only
 *    thing standing between "closed" and "closed until someone opens a period
 *    on top of it".
 *
 * Periods are never created implicitly. A human opens one, on the record.
 */

/** A period as every consumer here needs to see it (a superset is fine). */
export interface PeriodWindow {
  id?: string;
  name: string;
  startDate: Date;
  endDate: Date;
  isClosed: boolean;
  locked: boolean;
}

/** Just the span — used by the overlap test, which ignores status by design. */
export interface PeriodSpan {
  startDate: Date;
  endDate: Date;
}

/** Names are shown in error messages and the ledger UI; keep them short. */
export const MAX_PERIOD_NAME_LENGTH = 60;

/**
 * Longest span one period may cover, in days (~18 months — a long financial
 * year plus slack for a transitional one).
 *
 * This is a control, not a nuisance: "1900-01-01 to 2099-12-31" would be a
 * period in name only. It would never be closed, so nothing would ever become
 * final, and the fiscal-period gate would be reduced to decoration. Splitting
 * a longer stretch into real years costs the operator one extra form.
 */
export const MAX_PERIOD_DAYS = 550;

const MS_PER_DAY = 86_400_000;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * "12 July 2026" — how a person writes a date. Deliberately NOT
 * toLocaleDateString: that is what produced the "7/12/2026" in the original
 * error message, which an operator outside the US reads as 7 December.
 * Formatted in UTC, the same zone the periods are normalised to.
 */
export function formatPeriodDate(date: Date): string {
  return `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** Inclusive span, e.g. "1 January 2026 – 31 December 2026". */
export function formatPeriodSpan(period: PeriodSpan): string {
  return `${formatPeriodDate(period.startDate)} – ${formatPeriodDate(period.endDate)}`;
}

/** Open = neither closed nor locked. Mirrors checkFiscalPeriod exactly. */
export function isPeriodOpen(period: Pick<PeriodWindow, 'isClosed' | 'locked'>): boolean {
  return !period.isClosed && !period.locked;
}

/**
 * startDate <= date <= endDate — byte-for-byte the comparison
 * LedgerService.checkFiscalPeriod runs in SQL. Status is NOT considered here;
 * "does this period cover the date" and "is this period open" are separate
 * questions, and conflating them is how a closed period silently disappears
 * from an overlap check.
 */
export function periodCoversDate(period: PeriodSpan, date: Date): boolean {
  return period.startDate.getTime() <= date.getTime() && date.getTime() <= period.endDate.getTime();
}

/** The OPEN period covering `date`, or null. */
export function findOpenPeriodForDate(
  periods: readonly PeriodWindow[],
  date: Date,
): PeriodWindow | null {
  return periods.find((p) => isPeriodOpen(p) && periodCoversDate(p, date)) ?? null;
}

/** True when an entry dated `date` would be accepted by the ledger. */
export function hasOpenPeriodCovering(periods: readonly PeriodWindow[], date: Date): boolean {
  return findOpenPeriodForDate(periods, date) !== null;
}

/** True when the two spans share at least one instant. Adjacent is not overlap. */
export function periodsOverlap(a: PeriodSpan, b: PeriodSpan): boolean {
  return a.startDate.getTime() <= b.endDate.getTime() && b.startDate.getTime() <= a.endDate.getTime();
}

// ─── creating a period ────────────────────────────────────────────────────────

/** Raw form input: a name plus two `YYYY-MM-DD` dates. */
export interface NewPeriodInput {
  name: string;
  startDate: string;
  endDate: string;
}

/** The normalised, storable values. */
export interface NewPeriodValue {
  name: string;
  startDate: Date;
  endDate: Date;
}

export type ValidatedPeriod =
  | { ok: true; value: NewPeriodValue }
  | { ok: false; error: string };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `YYYY-MM-DD` → the first instant of that UTC day, or null.
 *
 * Rejects (rather than rolls over) impossible dates: `new Date('2026-13-01')`
 * is Invalid, but `Date.UTC(2026, 12, 1)` would silently become January 2027,
 * and a period the operator did not ask for is worse than an error message.
 */
function parseUtcDayStart(value: string): Date | null {
  const match = ISO_DATE.exec(value?.trim?.() ?? '');
  if (!match) return null;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rolled over (e.g. 31 February) → not the day that was typed.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

/** Last representable instant of the same UTC day. */
function endOfUtcDay(dayStart: Date): Date {
  return new Date(dayStart.getTime() + MS_PER_DAY - 1);
}

/**
 * Validate and normalise a period the operator typed, against the periods
 * that already exist.
 *
 * Normalisation matters: `startDate` becomes 00:00:00.000 UTC and `endDate`
 * 23:59:59.999 UTC of the chosen days, so the ledger's `endDate >= date`
 * comparison makes the final day genuinely inclusive whatever time of day an
 * entry carries. (prisma/seed.ts stored LOCAL midnight for both ends, which
 * quietly clipped the last day in any zone east of UTC.)
 *
 * `existing` must include CLOSED and LOCKED periods. Overlap is refused
 * against all of them, so no new period can ever be laid over a closed one —
 * that is what stops a closed period being reopened through the back door.
 *
 * Every error is a sentence a non-accountant can act on.
 */
export function validateNewPeriod(
  input: NewPeriodInput,
  existing: readonly PeriodWindow[],
): ValidatedPeriod {
  const name = (input?.name ?? '').trim();
  if (name.length === 0) {
    return { ok: false, error: 'Give this period a name, for example "FY 2026" or "July 2026".' };
  }
  if (name.length > MAX_PERIOD_NAME_LENGTH) {
    return {
      ok: false,
      error: `That name is too long — keep it under ${MAX_PERIOD_NAME_LENGTH} characters, for example "FY 2026".`,
    };
  }

  const startDate = parseUtcDayStart(input?.startDate ?? '');
  if (!startDate) {
    return {
      ok: false,
      error: 'Enter a start date as year-month-day, for example 2026-01-01.',
    };
  }
  const endDay = parseUtcDayStart(input?.endDate ?? '');
  if (!endDay) {
    return {
      ok: false,
      error: 'Enter an end date as year-month-day, for example 2026-12-31.',
    };
  }
  if (endDay.getTime() < startDate.getTime()) {
    return { ok: false, error: 'The end date must be on or after the start date.' };
  }

  const days = Math.round((endDay.getTime() - startDate.getTime()) / MS_PER_DAY) + 1;
  if (days > MAX_PERIOD_DAYS) {
    return {
      ok: false,
      error:
        `A period cannot be longer than about 18 months (${MAX_PERIOD_DAYS} days), and this one is ${days} days. ` +
        'Create one period per financial year instead — that is what lets you close a year and lock its figures.',
    };
  }

  const endDate = endOfUtcDay(endDay);
  const clash = existing.find((p) => periodsOverlap({ startDate, endDate }, p));
  if (clash) {
    return {
      ok: false,
      error:
        `Those dates overlap "${clash.name}" (${formatPeriodSpan(clash)}), which already exists. ` +
        'Periods must not overlap, so that every entry belongs to exactly one period. ' +
        'Choose dates outside it.',
    };
  }

  return { ok: true, value: { name, startDate, endDate } };
}

/**
 * The period to offer someone with none: the calendar year they are standing
 * in. Not created automatically — it pre-fills a form the operator confirms.
 */
export function suggestCurrentYearPeriod(now: Date): NewPeriodInput {
  const year = now.getUTCFullYear();
  return {
    name: `FY ${year}`,
    startDate: `${year}-01-01`,
    endDate: `${year}-12-31`,
  };
}

// ─── operator-facing copy, shared by every import path ───────────────────────

/**
 * The page an operator is sent to. Kept here so the import paths, the action
 * centre and the page itself cannot drift apart.
 */
export const FISCAL_PERIOD_PAGE_PATH = '/periods';

/**
 * Evidence-log event types for the two things an operator can do to a period.
 *
 * They live here rather than in fiscal-period.actions.ts because a `'use
 * server'` module may only export async functions — a constant exported from
 * one is a build error, not a lint nit.
 */
export const FISCAL_PERIOD_OPENED_EVENT = 'FISCAL_PERIOD_OPENED';
export const FISCAL_PERIOD_CLOSED_EVENT = 'FISCAL_PERIOD_CLOSED';

/**
 * Shown when the organisation has NO open period at all — the state a fresh
 * deployment is in, and the reason every receipt import was failing. Says what
 * happened, what to do, and (because it is used where OCR has not run yet)
 * that nothing was spent.
 */
export const NO_OPEN_PERIOD_MESSAGE =
  'Your books have no open accounting period, so nothing can be recorded yet. ' +
  'Open one on the Accounting periods page, then run this import again. ' +
  'Nothing was read from this file and nothing was charged for it.';

/**
 * Shown when periods exist but none of them covers this receipt's date — for
 * example a July receipt when only last year is open. Names the date, because
 * "no fiscal period defined" told the operator nothing he could act on.
 */
export function dateOutsidePeriodsMessage(date: Date): string {
  return (
    `This receipt is dated ${formatPeriodDate(date)}, and no open accounting period covers that date. ` +
    'Open a period that includes it on the Accounting periods page, then run this import again. ' +
    'Nothing was changed in your books.'
  );
}

/**
 * Same situation, for a whole batch: names the dates that are not covered so
 * the operator knows exactly which period he is missing.
 */
export function datesOutsidePeriodsMessage(dates: readonly Date[]): string {
  const unique = [...new Set(dates.map((d) => d.toISOString().slice(0, 10)))].sort();
  const shown = unique.slice(0, 5).map((d) => formatPeriodDate(new Date(`${d}T00:00:00.000Z`)));
  const tail = unique.length > shown.length ? ` and ${unique.length - shown.length} more` : '';
  return (
    `No open accounting period covers ${shown.join(', ')}${tail}. ` +
    'Open a period that includes those dates on the Accounting periods page, then run this import again.'
  );
}
