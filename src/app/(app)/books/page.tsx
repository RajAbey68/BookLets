import { fetchBooksView } from '@/app/actions/books.actions';
import { BOOKS_MONTH_CAP } from '@/lib/books-view';
import SandboxBooksTabs from '@/components/SandboxBooksTabs';

// Reads from the database; cannot be rendered at build time.
export const dynamic = 'force-dynamic';

const formatDate = (iso: string) =>
  new Intl.DateTimeFormat('en-IE', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso));

/** Per-row currency (entries can be EUR or LKR); falls back to a plain suffix. */
const formatAmount = (amount: string, currency: string) => {
  try {
    return new Intl.NumberFormat('en-IE', { style: 'currency', currency }).format(Number(amount));
  } catch {
    return `${amount} ${currency}`;
  }
};

/**
 * S11 — /books: what has actually made it into the books. POSTED entries
 * only (drafts stay in the sandbox), grouped by month, newest first, capped
 * to the most recent months. Org-scoped server-side via fetchBooksView.
 */
export default async function BooksPage() {
  const { months, truncated } = await fetchBooksView();

  return (
    <>
      <div style={{ marginBottom: '1.5rem' }}>
        <div style={{ fontSize: '0.875rem', color: 'var(--accent-color)', fontWeight: '600', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Workspace
        </div>
        <h1 style={{ marginBottom: '0.5rem' }}>Books</h1>
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
          Approved, posted entries — the books of record. Anything still awaiting consensus is
          in the Sandbox.
        </p>
      </div>

      <SandboxBooksTabs active="books" />

      {months.length === 0 ? (
        <div className="glass-card" style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
          Nothing posted yet. Upload receipts in the Sandbox and approve them to fill the books.
        </div>
      ) : (
        months.map((month) => (
          <div key={month.key} style={{ marginBottom: '2rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
              <h2 style={{ fontSize: '1.125rem', margin: 0 }}>{month.label}</h2>
              {month.period ? (
                <>
                  <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                    {month.period.name}
                  </span>
                  <span className={month.period.open ? 'badge badge-success' : 'badge badge-warning'}>
                    {month.period.open ? 'Open' : 'Closed'}
                  </span>
                </>
              ) : (
                <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                  No accounting period covers this month
                </span>
              )}
            </div>

            <div className="glass-card" style={{ padding: '0.5rem 1rem' }}>
              <table className="premium-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Memo</th>
                    <th>Vendor / accounts</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {month.rows.map((row) => (
                    <tr key={row.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                      <td data-label="Date" style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem', padding: '0.75rem 1rem', whiteSpace: 'nowrap' }}>
                        {formatDate(row.date)}
                      </td>
                      <td data-label="Memo" style={{ padding: '0.75rem 1rem' }}>
                        {row.memo || '—'}
                      </td>
                      <td data-label="Vendor / accounts" style={{ color: 'var(--text-secondary)', padding: '0.75rem 1rem' }}>
                        {row.vendorish}
                      </td>
                      <td data-label="Amount" style={{ textAlign: 'right', fontWeight: 'bold', padding: '0.75rem 1rem', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                        {formatAmount(row.amount, row.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

      {truncated && (
        <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
          Showing the most recent {BOOKS_MONTH_CAP} months. Older entries are in the{' '}
          <a href="/ledger" style={{ color: 'var(--accent-color)' }}>General Ledger</a> and the CSV export.
        </p>
      )}
    </>
  );
}
