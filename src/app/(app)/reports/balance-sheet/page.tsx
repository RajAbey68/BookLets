import Link from 'next/link';
import AsOfDateFilter from '@/components/AsOfDateFilter';
import { getBalanceSheetReport } from '@/lib/balance-sheet-report';
import type { BalanceSheetSection } from '@/lib/balance-sheet';

// Reads from the database; cannot be rendered at build time.
export const dynamic = 'force-dynamic';

const formatCurrency = (amount: { toString(): string }) =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(Number(amount));

function SectionTable({ title, section }: { title: string; section: BalanceSheetSection }) {
  return (
    <div className="glass-card" style={{ marginBottom: '1.5rem' }}>
      <h3 style={{ marginBottom: '1rem', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: '0.875rem', color: 'var(--accent-color)' }}>
        {title}
      </h3>
      <table className="premium-table">
        <thead>
          <tr>
            <th>Code</th>
            <th>Account</th>
            <th style={{ textAlign: 'right' }}>Balance</th>
          </tr>
        </thead>
        <tbody>
          {section.rows.length === 0 ? (
            <tr>
              <td colSpan={3} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                No activity
              </td>
            </tr>
          ) : (
            section.rows.map((row) => (
              <tr key={row.accountId} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                <td data-label="Code" style={{ padding: '0.875rem 1rem', color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                  {row.code ?? '—'}
                </td>
                <td
                  data-label="Account"
                  style={{ padding: '0.875rem 1rem', fontWeight: row.depth === 0 ? 600 : 400, paddingLeft: `${1 + row.depth * 1.25}rem`, fontStyle: row.synthetic ? 'italic' : 'normal' }}
                >
                  {row.name}
                </td>
                <td
                  data-label="Balance"
                  style={{ textAlign: 'right', padding: '0.875rem 1rem', fontWeight: 600, color: row.rolledUpBalance.isNegative() ? 'var(--danger-color)' : 'var(--text-primary)' }}
                >
                  {formatCurrency(row.rolledUpBalance)}
                </td>
              </tr>
            ))
          )}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '2px solid var(--surface-border)', fontWeight: 700 }}>
            <td colSpan={2} style={{ padding: '0.875rem 1rem' }}>Total {title}</td>
            <td style={{ textAlign: 'right', padding: '0.875rem 1rem' }}>{formatCurrency(section.total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export default async function BalanceSheetPage({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  const { asOf } = await searchParams;
  const report = await getBalanceSheetReport(asOf);

  if (!report.ok) {
    return (
      <div className="glass-card" style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
        <h3 style={{ marginBottom: '0.5rem' }}>Balance Sheet unavailable</h3>
        <p style={{ fontSize: '0.875rem' }}>{report.error}</p>
      </div>
    );
  }

  const { balanceSheet: bs } = report;
  const liabilitiesPlusEquity = bs.liabilities.total.plus(bs.equity.total);

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
          <h1 style={{ marginBottom: 0 }}>Balance Sheet</h1>
          <div style={{ marginTop: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
            {report.organizationName} · as of {report.asOf}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '1rem' }}>
          <AsOfDateFilter asOf={report.asOf} />
          <a
            href={`/api/export/balance-sheet?asOf=${encodeURIComponent(report.asOf)}`}
            download
            style={{ padding: '0.75rem 1.25rem', borderRadius: '10px', background: 'var(--surface-color)', border: '1px solid var(--surface-border)', color: 'var(--text-primary)', fontWeight: 600, cursor: 'pointer', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
          >
            Export CSV
          </a>
        </div>
      </div>

      <SectionTable title="Assets" section={bs.assets} />
      <SectionTable title="Liabilities" section={bs.liabilities} />
      <SectionTable title="Equity" section={bs.equity} />

      <div className="glass-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 700 }}>
        <div>
          Assets {formatCurrency(bs.assets.total)} · Liabilities + Equity {formatCurrency(liabilitiesPlusEquity)}
        </div>
        <div style={{ fontSize: '0.875rem', color: bs.balances ? 'var(--success-color)' : 'var(--danger-color)' }}>
          {bs.balances ? '● Balanced — Assets = Liabilities + Equity' : '● OUT OF BALANCE — ledger integrity issue'}
        </div>
      </div>
    </>
  );
}
