import Link from 'next/link';
import { fetchAccounts } from '@/app/actions/ledger.actions';
import JournalEntryForm, { type JournalAccountOption } from '@/components/JournalEntryForm';

// Reads from the database; cannot be rendered at build time.
export const dynamic = 'force-dynamic';

export default async function NewJournalEntryPage() {
  const accounts = await fetchAccounts();
  const options: JournalAccountOption[] = accounts.map((a) => ({
    id: a.id,
    name: a.name,
    code: a.code,
    type: a.type,
  }));

  return (
    <>
      <div style={{ marginBottom: '2rem' }}>
        <Link href="/ledger" style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', textDecoration: 'none', fontWeight: 600 }}>
          ← Back to General Ledger
        </Link>
      </div>

      <div style={{ marginBottom: '2.5rem' }}>
        <div style={{ fontSize: '0.875rem', color: 'var(--accent-color)', fontWeight: 600, marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Accounting
        </div>
        <h1 style={{ marginBottom: 0 }}>New Journal Entry</h1>
      </div>

      <JournalEntryForm accounts={options} />
    </>
  );
}
