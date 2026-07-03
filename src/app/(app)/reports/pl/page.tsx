import Link from 'next/link';
import PLPeriodFilter from '@/components/PLPeriodFilter';
import { getPLStatementReport } from '@/lib/pl-statement-report';
import type { PLRow, PLSection } from '@/lib/pl-statement';

// Reads from the database; cannot be rendered at build time.
export const dynamic = 'force-dynamic';

const formatCurrency = (amount: { toString(): string }) =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(Number(amount));

const formatDay = (date: Date) =>
  date.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** The range end is exclusive (start of the next day); display the last covered day. */
const lastCoveredDay = (endExclusive: Date) => new Date(endExclusive.getTime() - 1);

function SectionRows({ section }: { section: PLSection }) {
  return (
    <>
      {section.rows.map((row: PLRow) => (
        <tr key={row.accountId} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
          <td data-label="Code" style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>{row.code ?? '—'}</td>
          <td data-label="Account" style={{ padding: '1rem', fontWeight: row.depth === 0 ? 600 : 500, paddingLeft: `${1 + row.depth * 1.5}rem` }}>
            {row.name}
          </td>
          <td data-label="Amount" style={{ textAlign: 'right', padding: '1rem' }}>
            {row.ownAmount.isZero() ? '—' : formatCurrency(row.ownAmount)}
          </td>
          <td data-label="Rolled up" style={{ textAlign: 'right', padding: '1rem', fontWeight: 'bold' }}>
            {formatCurrency(row.rolledUpAmount)}
          </td>
        </tr>
      ))}
    </>
  );
}

export default async function PLStatementPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const { period } = await searchParams;
  const report = await getPLStatementReport(period, new Date());

  if (!report.ok) {
    return (
      <div className="glass-card" style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
        <h3 style={{ marginBottom: '0.5rem' }}>P&amp;L Statement unavailable</h3>
        <p style={{ fontSize: '0.875rem' }}>{report.error}</p>
      </div>
    );
  }

  const { statement, preset, presetOptions, range } = report;
  const isProfit = !statement.netProfit.isNegative();

  return (
    <>
      <div style={{ marginBottom: '1.5rem' }}>
        <Link href="/ledger" style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', textDecoration: 'none', fontWeight: 600 }}>
          ← Back to General Ledger
        </Link>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '2.5rem' }}>
        <div>
          <div style={{ fontSize: '0.875rem', color: 'var(--accent-color)', fontWeight: 600, marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Accounting · Reports
          </div>
          <h1 style={{ marginBottom: 0 }}>Profit &amp; Loss</h1>
          <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
            {formatDay(range.start)} – {formatDay(lastCoveredDay(range.endExclusive))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '1rem' }}>
          <PLPeriodFilter options={presetOptions} />
          <a
            href={`/api/export/pl?period=${encodeURIComponent(preset)}`}
            download
            style={{ padding: '0.75rem 1.25rem', borderRadius: '10px', background: 'var(--surface-color)', border: '1px solid var(--surface-border)', color: 'var(--text-primary)', fontWeight: 600, cursor: 'pointer', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
          >
            Export CSV
          </a>
        </div>
      </div>

      <div className="glass-card">
        <table className="premium-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Account</th>
              <th style={{ textAlign: 'right' }}>Amount</th>
              <th style={{ textAlign: 'right' }}>Rolled up</th>
            </tr>
          </thead>
          {statement.revenue.rows.length === 0 && statement.expenses.rows.length === 0 ? (
            <tbody>
              <tr>
                <td colSpan={4} style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-secondary)' }}>
                  <div style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>No activity this period</div>
                  <div>Post a journal entry or create a booking, or pick a wider period.</div>
                </td>
              </tr>
            </tbody>
          ) : (
            <tbody>
              <tr>
                <td colSpan={4} style={{ padding: '1rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                  Revenue
                </td>
              </tr>
              <SectionRows section={statement.revenue} />
              <tr style={{ borderTop: '1px solid var(--surface-border)', fontWeight: 700 }}>
                <td colSpan={3} style={{ padding: '1rem' }}>Total Revenue</td>
                <td style={{ textAlign: 'right', padding: '1rem', color: 'var(--success-color)' }}>{formatCurrency(statement.revenue.total)}</td>
              </tr>

              <tr>
                <td colSpan={4} style={{ padding: '1rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                  Expenses
                </td>
              </tr>
              <SectionRows section={statement.expenses} />
              <tr style={{ borderTop: '1px solid var(--surface-border)', fontWeight: 700 }}>
                <td colSpan={3} style={{ padding: '1rem' }}>Total Expenses</td>
                <td style={{ textAlign: 'right', padding: '1rem', color: 'var(--danger-color)' }}>{formatCurrency(statement.expenses.total)}</td>
              </tr>
            </tbody>
          )}
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--surface-border)', fontWeight: 700 }}>
              <td colSpan={3} style={{ padding: '1rem' }}>
                {isProfit ? 'Net Profit' : 'Net Loss'}
              </td>
              <td style={{ textAlign: 'right', padding: '1rem', color: isProfit ? 'var(--success-color)' : 'var(--danger-color)' }}>
                {formatCurrency(statement.netProfit)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}
