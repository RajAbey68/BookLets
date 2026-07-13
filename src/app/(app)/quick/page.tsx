import Link from 'next/link';
import { Decimal } from 'decimal.js';
import { fetchQuickEntryContext } from '@/app/actions/quick-entry.actions';
import QuickEntryForm from '@/components/QuickEntryForm';
import { monthlySummary, resolveEmptyState, type SummaryEntry } from '@/lib/quick-entry';

// Reads from the database; cannot be rendered at build time.
export const dynamic = 'force-dynamic';

/**
 * RAJ-481 — mobile quick-entry page: one-screen income/expense capture with
 * a rolling monthly summary. Guided empty states walk a fresh workspace from
 * first property → accounts → first entry.
 */
export default async function QuickEntryPage() {
  const context = await fetchQuickEntryContext();

  if (!context) {
    return (
      <main style={{ padding: '1rem', maxWidth: 560, margin: '0 auto' }}>
        <h1 style={{ fontWeight: 800 }}>Quick entry</h1>
        <p style={{ color: 'var(--text-secondary)' }}>Sign in to record income and expenses.</p>
      </main>
    );
  }

  const emptyState = resolveEmptyState(context.counts);
  if (emptyState) {
    return (
      <main style={{ padding: '1rem', maxWidth: 560, margin: '0 auto' }}>
        <h1 style={{ fontWeight: 800 }}>Quick entry</h1>
        <section
          className="glass-card"
          aria-labelledby="qe-empty-title"
          style={{ padding: '2rem 1.5rem', textAlign: 'center', borderRadius: 16 }}
        >
          <h2 id="qe-empty-title" style={{ fontWeight: 800, marginTop: 0 }}>{emptyState.title}</h2>
          <p style={{ color: 'var(--text-secondary)' }}>
            {emptyState.step === 'add-property' && 'BookLets organises every entry by property. Add your first one to get started.'}
            {emptyState.step === 'setup-accounts' && 'Set up your income and expense accounts so entries land in the right place.'}
            {emptyState.step === 'first-entry' && 'You are all set — record your first income or expense in under 15 seconds.'}
          </p>
          <Link
            href={emptyState.href}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: 48,
              padding: '0 1.5rem',
              borderRadius: 12,
              background: 'var(--accent)',
              color: '#fff',
              fontWeight: 700,
              textDecoration: 'none',
            }}
          >
            {emptyState.cta}
          </Link>
        </section>
      </main>
    );
  }

  const summaryEntries: SummaryEntry[] = context.summaryEntries.map(r => ({
    date: new Date(r.dateIso),
    kind: r.kind,
    amount: new Decimal(r.amount),
    propertyId: r.propertyId,
  }));
  const months = monthlySummary(summaryEntries).slice(0, 3);
  const gbp = (d: Decimal) =>
    `£${d.toNumber().toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <main style={{ padding: '1rem', maxWidth: 560, margin: '0 auto', display: 'grid', gap: '1.25rem' }}>
      <h1 style={{ fontWeight: 800, margin: 0 }}>Quick entry</h1>

      <section className="glass-card" aria-label="New entry" style={{ padding: '1.25rem', borderRadius: 16 }}>
        <QuickEntryForm properties={context.properties} accounts={context.accounts} />
      </section>

      {months.length > 0 && (
        <section className="glass-card" aria-labelledby="qe-summary-title" style={{ padding: '1.25rem', borderRadius: 16 }}>
          <h2 id="qe-summary-title" style={{ fontSize: '0.875rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', marginTop: 0 }}>
            Monthly summary
          </h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9375rem' }}>
            <thead>
              <tr style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                <th scope="col" style={{ textAlign: 'left', paddingBottom: 8 }}>Month</th>
                <th scope="col" style={{ paddingBottom: 8 }}>In</th>
                <th scope="col" style={{ paddingBottom: 8 }}>Out</th>
                <th scope="col" style={{ paddingBottom: 8 }}>Net</th>
              </tr>
            </thead>
            <tbody>
              {months.map(m => (
                <tr key={m.month} style={{ borderTop: '1px solid var(--surface-border)', textAlign: 'right' }}>
                  <td style={{ textAlign: 'left', padding: '10px 0' }}>
                    {new Date(`${m.month}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })}
                  </td>
                  <td style={{ color: 'var(--success, #10b981)' }}>{gbp(m.income)}</td>
                  <td style={{ color: 'var(--danger, #f43f5e)' }}>{gbp(m.expenses)}</td>
                  <td style={{ fontWeight: 700 }}>{gbp(m.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: 0 }}>
            Full ledger, per-property reports and CSV export live in <Link href="/ledger" style={{ color: 'var(--accent)' }}>Ledger</Link> and{' '}
            <Link href="/reports" style={{ color: 'var(--accent)' }}>Reports</Link>.
          </p>
        </section>
      )}
    </main>
  );
}
