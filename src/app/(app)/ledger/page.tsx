import Link from 'next/link';
import { fetchLedgerEntries } from '@/app/actions/ledger.actions';
import LedgerPeriodFilter, { type LedgerPeriodOption } from '@/components/LedgerPeriodFilter';
import {
  DRILLDOWN_METRIC_LABELS,
  computeDrilldownTotal,
  entryLineMatches,
  getDrilldownFilter,
  parseDrilldownMetric,
} from '@/lib/metric-drilldown';

// Reads from the database; cannot be rendered at build time.
export const dynamic = 'force-dynamic';

type LedgerEntry = Awaited<ReturnType<typeof fetchLedgerEntries>>[number];
type LedgerLine = LedgerEntry['lines'][number];

const monthKey = (date: Date | string) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${d.getMonth()}`;
};

export default async function LedgerPage({ searchParams }: { searchParams: Promise<{ period?: string; metric?: string }> }) {
  const { period, metric } = await searchParams;
  const allEntries = await fetchLedgerEntries();

  // RAJ-291 drill-down: /ledger?metric=revenue|netIncome shows exactly the
  // journal lines behind the corresponding dashboard stat card, plus a total
  // row that reconciles with the dashboard number.
  const drilldownMetric = parseDrilldownMetric(metric);
  const drilldown = drilldownMetric ? getDrilldownFilter(drilldownMetric, new Date()) : null;

  // Period options are derived from the actual entry dates, newest first.
  const monthLabels = new Map<string, string>();
  for (const entry of allEntries) {
    const key = monthKey(entry.date);
    if (!monthLabels.has(key)) {
      monthLabels.set(key, new Date(entry.date).toLocaleString('en-IE', { month: 'long', year: 'numeric' }));
    }
  }
  const sortedMonths = [...monthLabels.entries()].sort((a, b) => {
    const [ay, am] = a[0].split('-').map(Number);
    const [by, bm] = b[0].split('-').map(Number);
    return by !== ay ? by - ay : bm - am;
  });
  const periodOptions: LedgerPeriodOption[] = [
    { value: 'all', label: 'All Time' },
    ...sortedMonths.map(([value, label]) => ({ value, label })),
  ];

  const selectedPeriod = period && monthLabels.has(period) ? period : 'all';

  // In drill-down mode the metric defines the window (MTD) and predicate, so
  // the period filter does not apply. Only lines on the metric's account
  // types count — other lines of the same entry are omitted, exactly as in
  // MetricsService.getPortfolioMetrics.
  const entries = drilldown
    ? allEntries
        .map((entry) => ({
          ...entry,
          lines: entry.lines.filter((line) => entryLineMatches(drilldown, entry, line.account.type)),
        }))
        .filter((entry) => entry.lines.length > 0)
    : selectedPeriod === 'all'
      ? allEntries
      : allEntries.filter((entry) => monthKey(entry.date) === selectedPeriod);

  const drilldownTotal = drilldown
    ? computeDrilldownTotal(
        entries.flatMap((entry) =>
          entry.lines.map((line) => ({
            amount: line.amount.toString(),
            isDebit: line.isDebit,
            accountType: line.account.type,
          })),
        ),
        drilldown.metric,
      )
    : null;

  const formatCurrency = (amount: number | { toString(): string }) => {
    return new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: 'EUR',
    }).format(Number(amount));
  };

  const formatDate = (date: Date | string) => {
      return new Intl.DateTimeFormat('en-IE', { dateStyle: 'medium' }).format(new Date(date));
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '2.5rem' }}>
        <div>
          <div style={{ fontSize: '0.875rem', color: 'var(--accent-color)', fontWeight: '600', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Accounting
          </div>
          <h1 style={{ marginBottom: 0 }}>General Ledger</h1>
        </div>
        
        <div style={{ display: 'flex', gap: '1rem' }}>
          {!drilldown && <LedgerPeriodFilter options={periodOptions} />}
          <a
            href="/ledger/new"
            style={{ padding: '0.75rem 1.25rem', borderRadius: '10px', background: 'var(--accent-color)', border: 'none', color: '#fff', fontWeight: '600', cursor: 'pointer', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
          >
            + New Entry
          </a>
          <a
            href="/reports/trial-balance"
            style={{ padding: '0.75rem 1.25rem', borderRadius: '10px', background: 'var(--surface-color)', border: '1px solid var(--surface-border)', color: 'var(--text-primary)', fontWeight: '600', cursor: 'pointer', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
          >
            Trial Balance
          </a>
          <a
            href="/api/export/ledger"
            download
            style={{ padding: '0.75rem 1.25rem', borderRadius: '10px', background: 'var(--surface-color)', border: '1px solid var(--surface-border)', color: 'var(--text-primary)', fontWeight: '600', cursor: 'pointer', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
          >
            Export CSV
          </a>
        </div>
      </div>

      {drilldown && drilldownTotal !== null && (
        <div
          className="glass-card"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', padding: '1rem 1.5rem' }}
        >
          <div>
            <div style={{ fontSize: '0.75rem', color: 'var(--accent-color)', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>
              Dashboard drill-down
            </div>
            <div style={{ fontWeight: '600' }}>
              {DRILLDOWN_METRIC_LABELS[drilldown.metric]} — POSTED entries since {formatDate(drilldown.dateFrom)}
            </div>
            <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
              Total below equals the dashboard figure for this metric.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
            <div style={{ fontSize: '1.5rem', fontWeight: '700', color: 'var(--accent-color)' }}>
              {formatCurrency(drilldownTotal.toNumber())}
            </div>
            <Link
              href="/ledger"
              style={{ padding: '0.5rem 1rem', borderRadius: '10px', background: 'var(--surface-color)', border: '1px solid var(--surface-border)', color: 'var(--text-primary)', fontWeight: '600', fontSize: '0.8125rem', textDecoration: 'none' }}
            >
              Clear filter
            </Link>
          </div>
        </div>
      )}

      <div className="glass-card">
        <table className="premium-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Reference</th>
              <th>Account</th>
              <th>Memo / Description</th>
              <th style={{ textAlign: 'right' }}>Debit</th>
              <th style={{ textAlign: 'right' }}>Credit</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-secondary)' }}>
                  <div style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>
                    {drilldown ? 'No journal entries behind this metric yet' : 'No ledger entries found'}
                  </div>
                  <div>
                    {drilldown
                      ? 'No POSTED entries on this metric’s accounts in the month-to-date window. If the dashboard shows a non-zero figure, the numbers have not reconciled — please report it.'
                      : 'Sync your Hostaway account to populate the ledger.'}
                  </div>
                </td>
              </tr>
            ) : (
              entries.flatMap((entry: LedgerEntry) =>
                entry.lines.map((line: LedgerLine, lineIndex: number) => (
                  <tr key={`${entry.id}-${lineIndex}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                    {lineIndex === 0 ? (
                      <td 
                        data-label="Date" 
                        rowSpan={entry.lines.length}
                        style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem', padding: '1rem', verticalAlign: 'top' }}
                      >
                        {formatDate(entry.date)}
                      </td>
                    ) : null}
                    
                    {lineIndex === 0 ? (
                      <td 
                        data-label="Reference" 
                        rowSpan={entry.lines.length}
                        style={{ fontWeight: '600', color: 'var(--accent-color)', padding: '1rem', verticalAlign: 'top' }}
                      >
                        {entry.id.substring(0, 8).toUpperCase()}
                      </td>
                    ) : null}

                    <td data-label="Account" style={{ padding: '1rem' }}>
                      <div style={{ fontWeight: '500' }}>{line.account.name}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{entry.status}</div>
                    </td>
                    
                    <td data-label="Memo" style={{ color: 'var(--text-secondary)', padding: '1rem' }}>
                      {entry.memo || '—'}
                    </td>
                    
                    <td data-label="Debit" style={{ textAlign: 'right', fontWeight: 'bold', color: line.isDebit ? 'var(--success-color)' : 'transparent', padding: '1rem' }}>
                      {line.isDebit ? formatCurrency(line.amount) : '—'}
                    </td>
                    
                    <td data-label="Credit" style={{ textAlign: 'right', fontWeight: 'bold', color: !line.isDebit ? 'var(--danger-color)' : 'transparent', padding: '1rem' }}>
                      {!line.isDebit ? formatCurrency(line.amount) : '—'}
                    </td>
                  </tr>
                ))
              )
            )}
          </tbody>
          {drilldown && drilldownTotal !== null && entries.length > 0 && (
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--surface-border)' }}>
                <td colSpan={5} style={{ textAlign: 'right', padding: '1rem', fontWeight: '700' }}>
                  {DRILLDOWN_METRIC_LABELS[drilldown.metric]} — reconciled total
                </td>
                <td style={{ textAlign: 'right', padding: '1rem', fontWeight: '700', color: 'var(--accent-color)' }}>
                  {formatCurrency(drilldownTotal.toNumber())}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </>
  );
}
