import { fetchLedgerEntries } from '@/app/actions/ledger.actions';

export default async function LedgerPage() {
  const entries = await fetchLedgerEntries();

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: 'EUR',
    }).format(amount);
  };

  const formatDate = (dateString: string) => {
      return new Intl.DateTimeFormat('en-IE', { dateStyle: 'medium' }).format(new Date(dateString));
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
          <div style={{ display: 'flex', alignItems: 'center', background: 'var(--surface-color)', padding: '0.5rem 1rem', borderRadius: '10px', border: '1px solid var(--surface-border)', gap: '0.5rem', fontSize: '0.875rem' }}>
            <span style={{ color: 'var(--text-secondary)' }}>Period:</span>
            <select style={{ background: 'none', border: 'none', color: 'var(--text-primary)', outline: 'none', fontWeight: '600' }}>
              <option>All Time</option>
              <option>October 2026</option>
              <option>September 2026</option>
            </select>
          </div>
          <button style={{ padding: '0.75rem 1.25rem', borderRadius: '10px', background: 'var(--accent-color)', border: 'none', color: '#fff', fontWeight: '600', cursor: 'pointer' }}>
            Export CSV
          </button>
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
              entries.flatMap((entry: any) => 
                entry.lines.map((line: any, lineIndex: number) => (
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
