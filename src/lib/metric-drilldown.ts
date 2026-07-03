import { Decimal } from 'decimal.js';

/**
 * RAJ-291 [P1-09] — Dashboard drill-down.
 *
 * Maps each money metric on the dashboard to the exact ledger predicate that
 * produced it in MetricsService.getPortfolioMetrics: POSTED journal entries,
 * dated on/after the first of the current month, on REVENUE (and for net
 * income also EXPENSE) accounts. Pure — no DB, no IO. The ledger page uses
 * these descriptors to show the underlying journal lines plus a total row
 * that reconciles with the dashboard number.
 *
 * Only the ledger-backed money metrics drill down. ADR / RevPAR / Occupancy
 * are booking-derived ratios and have no single set of journal lines behind
 * them.
 */

export type DrilldownMetric = 'revenue' | 'netIncome';

export interface DrilldownFilter {
  metric: DrilldownMetric;
  /** Only POSTED entries count toward dashboard metrics. */
  status: 'POSTED';
  /** Inclusive lower bound — metrics.service uses `date: { gte: firstOfMonth }`. */
  dateFrom: Date;
  accountTypes: readonly ('REVENUE' | 'EXPENSE')[];
}

export const DRILLDOWN_METRIC_LABELS: Record<DrilldownMetric, string> = {
  revenue: 'Total Revenue (MTD)',
  netIncome: 'Net Income (MTD)',
};

/**
 * The month-to-date window start — the same expression metrics.service uses
 * for `firstOfMonth`. Shared so dashboard and drill-down can never disagree
 * on the boundary.
 */
export function monthToDateStart(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export function getDrilldownFilter(metric: DrilldownMetric, now: Date): DrilldownFilter {
  return {
    metric,
    status: 'POSTED',
    dateFrom: monthToDateStart(now),
    accountTypes: metric === 'revenue' ? ['REVENUE'] : ['REVENUE', 'EXPENSE'],
  };
}

/** Ledger URL a dashboard stat card links to. */
export function drilldownHref(metric: DrilldownMetric): string {
  return `/ledger?metric=${metric}`;
}

/** Validate the untrusted `metric` search param. */
export function parseDrilldownMetric(value: string | undefined): DrilldownMetric | null {
  return value === 'revenue' || value === 'netIncome' ? value : null;
}

/**
 * Does a journal line belong to this metric? Entry-level predicate
 * (status + date, matching the Prisma `journalEntry` clause) plus the
 * line's account type (matching the `account.type` clause).
 */
export function entryLineMatches(
  filter: DrilldownFilter,
  entry: { status: string; date: Date | string },
  accountType: string,
): boolean {
  if (entry.status !== filter.status) return false;
  if (new Date(entry.date).getTime() < filter.dateFrom.getTime()) return false;
  return (filter.accountTypes as readonly string[]).includes(accountType);
}

export interface DrilldownLine {
  amount: string | number | { toString(): string };
  isDebit: boolean;
  accountType: string;
}

/**
 * Total of the drilled-down lines under the metric's own sign conventions:
 * - revenue:   CR adds, DR subtracts (CR-normal account) — as in metrics.service
 * - netIncome: revenue − expenses. An EXPENSE debit reduces net income, an
 *   EXPENSE credit restores it — so for both account types the contribution
 *   collapses to (credit − debit).
 */
export function computeDrilldownTotal(lines: readonly DrilldownLine[]): Decimal {
  return lines.reduce(
    (acc, line) => (line.isDebit ? acc.minus(new Decimal(line.amount.toString())) : acc.plus(new Decimal(line.amount.toString()))),
    new Decimal(0),
  );
}
