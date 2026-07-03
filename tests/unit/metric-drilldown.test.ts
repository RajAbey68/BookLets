/**
 * RAJ-291 [P1-09] — Dashboard drill-down.
 *
 * Each money metric on the dashboard (Total Revenue, Net Income) maps to a
 * ledger filter descriptor. The reconciliation guarantee: the descriptor's
 * window/status/account-types are exactly those MetricsService.getPortfolioMetrics
 * uses, and computeDrilldownTotal applies the same sign conventions, so the
 * drill-down total equals the dashboard number. Pure — no DB.
 */
import { describe, it, expect } from 'vitest';
import {
  monthToDateStart,
  getDrilldownFilter,
  drilldownHref,
  parseDrilldownMetric,
  entryLineMatches,
  computeDrilldownTotal,
  type DrilldownLine,
} from '../../src/lib/metric-drilldown';

const NOW = new Date(2026, 6, 3, 14, 30); // 3 July 2026, mid-day

const rev = (amount: string, isDebit: boolean): DrilldownLine => ({ amount, isDebit, accountType: 'REVENUE' });
const exp = (amount: string, isDebit: boolean): DrilldownLine => ({ amount, isDebit, accountType: 'EXPENSE' });

describe('monthToDateStart', () => {
  it('returns midnight on the 1st of the current month (metrics.service window boundary)', () => {
    const start = monthToDateStart(NOW);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(6);
    expect(start.getDate()).toBe(1);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    // Exactly the expression metrics.service uses for firstOfMonth
    expect(start.getTime()).toBe(new Date(NOW.getFullYear(), NOW.getMonth(), 1).getTime());
  });
});

describe('getDrilldownFilter', () => {
  it('revenue: POSTED + REVENUE accounts + MTD window — mirrors getPortfolioMetrics revenue query', () => {
    const f = getDrilldownFilter('revenue', NOW);
    expect(f.metric).toBe('revenue');
    expect(f.status).toBe('POSTED');
    expect(f.accountTypes).toEqual(['REVENUE']);
    expect(f.dateFrom.getTime()).toBe(monthToDateStart(NOW).getTime());
  });

  it('netIncome: POSTED + REVENUE and EXPENSE accounts + the same MTD window', () => {
    const f = getDrilldownFilter('netIncome', NOW);
    expect(f.metric).toBe('netIncome');
    expect(f.status).toBe('POSTED');
    expect(f.accountTypes).toEqual(['REVENUE', 'EXPENSE']);
    expect(f.dateFrom.getTime()).toBe(monthToDateStart(NOW).getTime());
  });
});

describe('drilldownHref / parseDrilldownMetric', () => {
  it('round-trips each metric through the ledger URL', () => {
    expect(drilldownHref('revenue')).toBe('/ledger?metric=revenue');
    expect(drilldownHref('netIncome')).toBe('/ledger?metric=netIncome');
    expect(parseDrilldownMetric('revenue')).toBe('revenue');
    expect(parseDrilldownMetric('netIncome')).toBe('netIncome');
  });

  it('rejects unknown or missing metric params', () => {
    expect(parseDrilldownMetric(undefined)).toBeNull();
    expect(parseDrilldownMetric('occupancy')).toBeNull();
    expect(parseDrilldownMetric('DROP TABLE')).toBeNull();
  });
});

describe('entryLineMatches', () => {
  const f = getDrilldownFilter('revenue', NOW);

  it('accepts a POSTED in-window line on a REVENUE account', () => {
    expect(entryLineMatches(f, { status: 'POSTED', date: new Date(2026, 6, 2) }, 'REVENUE')).toBe(true);
  });

  it('accepts a line dated exactly on the window boundary (gte, like metrics.service)', () => {
    expect(entryLineMatches(f, { status: 'POSTED', date: monthToDateStart(NOW) }, 'REVENUE')).toBe(true);
  });

  it('rejects DRAFT/VOIDED entries, out-of-window dates, and other account types', () => {
    expect(entryLineMatches(f, { status: 'DRAFT', date: new Date(2026, 6, 2) }, 'REVENUE')).toBe(false);
    expect(entryLineMatches(f, { status: 'VOIDED', date: new Date(2026, 6, 2) }, 'REVENUE')).toBe(false);
    expect(entryLineMatches(f, { status: 'POSTED', date: new Date(2026, 5, 30) }, 'REVENUE')).toBe(false);
    expect(entryLineMatches(f, { status: 'POSTED', date: new Date(2026, 6, 2) }, 'EXPENSE')).toBe(false);
    expect(entryLineMatches(f, { status: 'POSTED', date: new Date(2026, 6, 2) }, 'ASSET')).toBe(false);
  });

  it('netIncome filter accepts both REVENUE and EXPENSE lines', () => {
    const ni = getDrilldownFilter('netIncome', NOW);
    expect(entryLineMatches(ni, { status: 'POSTED', date: new Date(2026, 6, 2) }, 'REVENUE')).toBe(true);
    expect(entryLineMatches(ni, { status: 'POSTED', date: new Date(2026, 6, 2) }, 'EXPENSE')).toBe(true);
    expect(entryLineMatches(ni, { status: 'POSTED', date: new Date(2026, 6, 2) }, 'ASSET')).toBe(false);
  });
});

describe('computeDrilldownTotal — sign conventions match getPortfolioMetrics', () => {
  it('revenue: credits add, debits subtract (CR-normal account)', () => {
    // metrics.service: curr.isDebit ? acc.minus(amount) : acc.plus(amount)
    const total = computeDrilldownTotal([rev('1000.00', false), rev('200.00', false), rev('50.00', true)]);
    expect(total.toFixed(2)).toBe('1150.00');
  });

  it('netIncome: revenue minus expenses (expense debits reduce, expense credits restore)', () => {
    // revenue 1000 CR − (expense 300 DR − expense 40 CR) = 740
    const total = computeDrilldownTotal([
      rev('1000.00', false), exp('300.00', true), exp('40.00', false),
    ]);
    expect(total.toFixed(2)).toBe('740.00');
  });

  it('returns 0.00 for no lines', () => {
    expect(computeDrilldownTotal([]).toFixed(2)).toBe('0.00');
  });

  it('uses Decimal math (no float drift on cents)', () => {
    const lines: DrilldownLine[] = Array.from({ length: 10 }, () => rev('0.10', false));
    expect(computeDrilldownTotal(lines).toFixed(2)).toBe('1.00');
  });
});
