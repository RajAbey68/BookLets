import SpreadsheetImporter from '@/components/SpreadsheetImporter';

// Requires a session (middleware) and parses on the server.
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Imports — BookLets',
};

export default function ImportsPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div>
        <div
          style={{
            fontSize: '0.875rem',
            color: 'var(--accent-color)',
            fontWeight: 600,
            marginBottom: '0.5rem',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          Accounts
        </div>
        <h1 style={{ marginBottom: 0 }}>Spreadsheet Import</h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
          Read-only preview of the monthly Income &amp; Petty Cash Analysis workbook.
          Confirms the parser sees what you see. Posting to the ledger comes in the next step.
        </p>
      </div>
      <SpreadsheetImporter />
    </div>
  );
}
