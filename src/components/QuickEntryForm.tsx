'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { submitQuickEntry } from '@/app/actions/quick-entry.actions';
import type { QuickEntryKind } from '@/lib/quick-entry';

/**
 * RAJ-481 — mobile-first quick income/expense entry.
 *
 * One-screen flow tuned for the "<15s to add an expense on site" task:
 * segmented income/expense toggle, big amount field (decimal keypad on
 * mobile), property + category + paid-with selectors, optional note.
 * Glass-dark per DESIGN.md; every target >=44px; every control labelled.
 */

export interface QuickEntryFormProps {
  properties: Array<{ id: string; name: string }>;
  accounts: Array<{ id: string; name: string; type: string }>;
}

const fieldStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.75rem',
  minHeight: 48,
  borderRadius: '10px',
  background: 'var(--surface-color)',
  border: '1px solid var(--surface-border)',
  color: 'var(--text-primary)',
  fontSize: '1rem',
  outline: 'none',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.75rem',
  color: 'var(--text-secondary)',
  marginBottom: '0.5rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const todayIso = () => new Date().toISOString().slice(0, 10);

export default function QuickEntryForm({ properties, accounts }: QuickEntryFormProps) {
  const router = useRouter();
  const [kind, setKind] = useState<QuickEntryKind>('expense');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIso());
  const [propertyId, setPropertyId] = useState(properties[0]?.id ?? '');
  const [categoryAccountId, setCategoryAccountId] = useState('');
  const [paymentAccountId, setPaymentAccountId] = useState('');
  const [memo, setMemo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const categoryAccounts = useMemo(
    () => accounts.filter(a => (kind === 'income' ? a.type === 'REVENUE' : a.type === 'EXPENSE')),
    [accounts, kind],
  );
  const paymentAccounts = useMemo(() => accounts.filter(a => a.type === 'ASSET'), [accounts]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setBusy(true);
    const property = properties.find(p => p.id === propertyId);
    const result = await submitQuickEntry({
      kind,
      amount,
      date,
      propertyId,
      propertyName: property?.name ?? '',
      categoryAccountId,
      paymentAccountId,
      memo,
    });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    // Reset for the next rapid entry (keep property/date/payment — the
    // common case on-site is several entries for the same property + day).
    setAmount('');
    setMemo('');
    setSaved(true);
    router.refresh();
  };

  const toggleStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    minHeight: 48,
    borderRadius: '10px',
    border: active ? '1px solid var(--accent)' : '1px solid var(--surface-border)',
    background: active ? 'rgba(59,130,246,0.15)' : 'var(--surface-color)',
    color: active ? 'var(--accent)' : 'var(--text-secondary)',
    fontWeight: 700,
    fontSize: '0.9375rem',
    cursor: 'pointer',
  });

  return (
    <form onSubmit={submit} aria-label="Quick entry" style={{ display: 'grid', gap: '1rem' }}>
      <div role="group" aria-label="Entry type" style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="button" style={toggleStyle(kind === 'expense')} aria-pressed={kind === 'expense'} onClick={() => { setKind('expense'); setCategoryAccountId(''); }}>
          Expense
        </button>
        <button type="button" style={toggleStyle(kind === 'income')} aria-pressed={kind === 'income'} onClick={() => { setKind('income'); setCategoryAccountId(''); }}>
          Income
        </button>
      </div>

      <div>
        <label htmlFor="qe-amount" style={labelStyle}>Amount</label>
        <input
          id="qe-amount"
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          required
          style={{ ...fieldStyle, fontSize: '1.5rem', fontWeight: 700 }}
        />
      </div>

      <div>
        <label htmlFor="qe-property" style={labelStyle}>Property</label>
        <select id="qe-property" value={propertyId} onChange={e => setPropertyId(e.target.value)} required style={fieldStyle}>
          {properties.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="qe-category" style={labelStyle}>{kind === 'income' ? 'Income category' : 'Expense category'}</label>
        <select id="qe-category" value={categoryAccountId} onChange={e => setCategoryAccountId(e.target.value)} required style={fieldStyle}>
          <option value="">Choose…</option>
          {categoryAccounts.map(a => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="qe-payment" style={labelStyle}>{kind === 'income' ? 'Paid into' : 'Paid with'}</label>
        <select id="qe-payment" value={paymentAccountId} onChange={e => setPaymentAccountId(e.target.value)} required style={fieldStyle}>
          <option value="">Choose…</option>
          {paymentAccounts.map(a => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
        <div>
          <label htmlFor="qe-date" style={labelStyle}>Date</label>
          <input id="qe-date" type="date" value={date} onChange={e => setDate(e.target.value)} required style={fieldStyle} />
        </div>
        <div>
          <label htmlFor="qe-memo" style={labelStyle}>Note (optional)</label>
          <input id="qe-memo" type="text" value={memo} onChange={e => setMemo(e.target.value)} placeholder="e.g. boiler part" style={fieldStyle} />
        </div>
      </div>

      {error && (
        <p role="alert" style={{ color: 'var(--danger, #f43f5e)', fontSize: '0.875rem', margin: 0 }}>{error}</p>
      )}
      {saved && !error && (
        <p role="status" style={{ color: 'var(--success, #10b981)', fontSize: '0.875rem', margin: 0 }}>
          Saved. Ready for the next one.
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        style={{
          minHeight: 52,
          borderRadius: '12px',
          border: 'none',
          background: 'var(--accent)',
          color: '#fff',
          fontWeight: 800,
          fontSize: '1rem',
          cursor: busy ? 'wait' : 'pointer',
          opacity: busy ? 0.7 : 1,
        }}
      >
        {busy ? 'Saving…' : kind === 'income' ? 'Add income' : 'Add expense'}
      </button>
    </form>
  );
}
