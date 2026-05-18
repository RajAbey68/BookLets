import { fetchLedgerEntries } from '@/app/actions/ledger.actions';
import LedgerPeriodFilter, { type LedgerPeriodOption } from '@/components/LedgerPeriodFilter';

// Reads from the database; cannot be rendered at build time.
export const dynamic = 'force-dynamic';

type LedgerEntry = Awaited<ReturnType<typeof fetchLedgerEntries>>[number];
type LedgerLine = LedgerEntry['lines'][number];

const monthKey = (date: Date | string) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${d.getMonth()}`;
};

export default async function LedgerPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const { period } = await searchParams;
  const allEntries = await fetchLedgerEntries();

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
  const entries = selectedPeriod === 'all'
    ? allEntries
    : allEntries.filter((entry) => monthKey(entry.date) === selectedPeriod);

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
          <LedgerPeriodFilter options={periodOptions} />
          <a
            href="/api/export/ledger"
            download
            style={{ padding: '0.75rem 1.25rem', borderRadius: '10px', background: 'var(--accent-color)', border: 'none', color: '#fff', fontWeight: '600', cursor: 'pointer', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
          >
            Export CSV
          </a>
        </div>
      </div>

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
                  <div style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>No ledger entries found</div>
                  <div>Sync your Hostaway account to populate the ledger.</div>
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
        </table>
      </div>
    </>
  );
}
