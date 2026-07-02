import Link from 'next/link';
import LedgerPeriodFilter from '@/components/LedgerPeriodFilter';
import { getTrialBalanceReport } from '@/lib/trial-balance-report';

// Reads from the database; cannot be rendered at build time.
export const dynamic = 'force-dynamic';

const formatCurrency = (amount: { toString(): string }) =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(Number(amount));

export default async function TrialBalancePage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const { period } = await searchParams;
  const report = await getTrialBalanceReport(period);

  if (!report.ok) {
    return (
      <div className="glass-card" style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
        <h3 style={{ marginBottom: '0.5rem' }}>Trial Balance unavailable</h3>
        <p style={{ fontSize: '0.875rem' }}>{report.error}</p>
      </div>
    );
  }

  const { trialBalance: tb, periodOptions, selectedPeriod } = report;
  const exportHref = selectedPeriod === 'all'
    ? '/api/export/trial-balance'
    : `/api/export/trial-balance?period=${encodeURIComponent(selectedPeriod)}`;

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
          <h1 style={{ marginBottom: 0 }}>Trial Balance</h1>
        </div>

        <div style={{ display: 'flex', gap: '1rem' }}>
          <LedgerPeriodFilter options={periodOptions} />
          <a
            href={exportHref}
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
              <th>Type</th>
              <th style={{ textAlign: 'right' }}>Debit</th>
              <th style={{ textAlign: 'right' }}>Credit</th>
            </tr>
          </thead>
          <tbody>
            {tb.rows.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-secondary)' }}>
                  <div style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>No posted entries</div>
                  <div>Post a journal entry or create a booking to populate the trial balance.</div>
                </td>
              </tr>
            ) : (
              tb.rows.map((row) => (
                <tr key={row.accountId} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                  <td data-label="Code" style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>{row.code ?? '—'}</td>
                  <td data-label="Account" style={{ padding: '1rem', fontWeight: 500 }}>{row.name}</td>
                  <td data-label="Type" style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>{row.type}</td>
                  <td data-label="Debit" style={{ textAlign: 'right', padding: '1rem', fontWeight: 'bold', color: row.debit.greaterThan(0) ? 'var(--success-color)' : 'transparent' }}>
                    {row.debit.greaterThan(0) ? formatCurrency(row.debit) : '—'}
                  </td>
                  <td data-label="Credit" style={{ textAlign: 'right', padding: '1rem', fontWeight: 'bold', color: row.credit.greaterThan(0) ? 'var(--danger-color)' : 'transparent' }}>
                    {row.credit.greaterThan(0) ? formatCurrency(row.credit) : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
          {tb.rows.length > 0 ? (
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--surface-border)', fontWeight: 700 }}>
                <td colSpan={3} style={{ padding: '1rem' }}>
                  Totals
                  <span style={{ marginLeft: '1rem', fontWeight: 600, fontSize: '0.8125rem', color: tb.isBalanced ? 'var(--success-color)' : 'var(--danger-color)' }}>
                    {tb.isBalanced ? '● Balanced' : '● Out of balance'}
                  </span>
                </td>
                <td style={{ textAlign: 'right', padding: '1rem' }}>{formatCurrency(tb.totalDebit)}</td>
                <td style={{ textAlign: 'right', padding: '1rem' }}>{formatCurrency(tb.totalCredit)}</td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </>
  );
}
