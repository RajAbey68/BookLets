'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Decimal } from 'decimal.js';
import { createManualJournalEntry } from '@/app/actions/ledger.actions';

export interface JournalAccountOption {
  id: string;
  name: string;
  code: string | null;
  type: string;
}

interface LineDraft {
  accountId: string;
  amount: string;
  isDebit: boolean;
}

const fieldStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.75rem',
  borderRadius: '10px',
  background: 'var(--surface-color)',
  border: '1px solid var(--surface-border)',
  color: 'var(--text-primary)',
  fontSize: '0.9375rem',
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

const emptyLine = (isDebit: boolean): LineDraft => ({ accountId: '', amount: '', isDebit });

const toDecimal = (value: string): Decimal => {
  try {
    const d = new Decimal(value || '0');
    return d.isFinite() ? d : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
};

export default function JournalEntryForm({ accounts }: { accounts: JournalAccountOption[] }) {
  const router = useRouter();
  const [date, setDate] = useState(todayIso());
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(true), emptyLine(false)]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { debit, credit, difference, balanced } = useMemo(() => {
    const debitTotal = lines.reduce((acc, l) => (l.isDebit ? acc.plus(toDecimal(l.amount)) : acc), new Decimal(0));
    const creditTotal = lines.reduce((acc, l) => (!l.isDebit ? acc.plus(toDecimal(l.amount)) : acc), new Decimal(0));
    const diff = debitTotal.minus(creditTotal);
    return {
      debit: debitTotal,
      credit: creditTotal,
      difference: diff,
      balanced: diff.isZero() && debitTotal.greaterThan(0),
    };
  }, [lines]);

  if (accounts.length === 0) {
    return (
      <div className="glass-card" style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
        <h3 style={{ marginBottom: '0.5rem' }}>No accounts yet</h3>
        <p style={{ fontSize: '0.875rem' }}>Set up your chart of accounts before posting a manual journal entry.</p>
      </div>
    );
  }

  const updateLine = (index: number, patch: Partial<LineDraft>) =>
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  const addLine = () => setLines((prev) => [...prev, emptyLine(false)]);

  const removeLine = (index: number) =>
    setLines((prev) => (prev.length <= 2 ? prev : prev.filter((_, i) => i !== index)));

  const fmt = (d: Decimal) =>
    new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(Number(d.toFixed(2)));

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const result = await createManualJournalEntry({ date, memo, lines });

    if (result.success) {
      router.push('/ledger');
      router.refresh();
    } else {
      setError(result.error);
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="glass-card" style={{ maxWidth: '820px', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: '1rem' }}>
        <div>
          <label style={labelStyle} htmlFor="entry-date">Date</label>
          <input
            id="entry-date"
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={fieldStyle}
          />
        </div>
        <div>
          <label style={labelStyle} htmlFor="entry-memo">Memo</label>
          <input
            id="entry-memo"
            type="text"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="e.g. Accrue March cleaning costs"
            style={fieldStyle}
          />
        </div>
      </div>

      <div>
        <div style={labelStyle}>Lines</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {lines.map((line, index) => (
            <div key={index} style={{ display: 'grid', gridTemplateColumns: '1fr 150px 120px 40px', gap: '0.75rem', alignItems: 'center' }}>
              <select
                aria-label={`Line ${index + 1} account`}
                required
                value={line.accountId}
                onChange={(e) => updateLine(index, { accountId: e.target.value })}
                style={fieldStyle}
              >
                <option value="" disabled>Select account</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.code ? `${a.code} · ${a.name}` : a.name}</option>
                ))}
              </select>

              <input
                aria-label={`Line ${index + 1} amount`}
                type="number"
                min="0.01"
                step="0.01"
                required
                value={line.amount}
                onChange={(e) => updateLine(index, { amount: e.target.value })}
                placeholder="0.00"
                style={{ ...fieldStyle, textAlign: 'right' }}
              />

              <div style={{ display: 'flex', borderRadius: '10px', overflow: 'hidden', border: '1px solid var(--surface-border)' }}>
                <button
                  type="button"
                  aria-pressed={line.isDebit}
                  onClick={() => updateLine(index, { isDebit: true })}
                  style={{ flex: 1, padding: '0.6rem 0', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '0.8125rem', background: line.isDebit ? 'var(--success-color)' : 'transparent', color: line.isDebit ? '#fff' : 'var(--text-secondary)' }}
                >
                  DR
                </button>
                <button
                  type="button"
                  aria-pressed={!line.isDebit}
                  onClick={() => updateLine(index, { isDebit: false })}
                  style={{ flex: 1, padding: '0.6rem 0', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '0.8125rem', background: !line.isDebit ? 'var(--danger-color)' : 'transparent', color: !line.isDebit ? '#fff' : 'var(--text-secondary)' }}
                >
                  CR
                </button>
              </div>

              <button
                type="button"
                onClick={() => removeLine(index)}
                disabled={lines.length <= 2}
                aria-label={`Remove line ${index + 1}`}
                style={{ padding: '0.6rem 0', borderRadius: '10px', border: '1px solid var(--surface-border)', background: 'transparent', color: 'var(--text-secondary)', cursor: lines.length <= 2 ? 'not-allowed' : 'pointer', opacity: lines.length <= 2 ? 0.4 : 1 }}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={addLine}
          style={{ marginTop: '0.75rem', padding: '0.5rem 1rem', borderRadius: '10px', border: '1px dashed var(--surface-border)', background: 'transparent', color: 'var(--accent-color)', fontWeight: 600, cursor: 'pointer', fontSize: '0.8125rem' }}
        >
          + Add line
        </button>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '2rem', padding: '1rem', borderRadius: '10px', background: 'var(--surface-color)', fontSize: '0.875rem' }}>
        <span style={{ color: 'var(--text-secondary)' }}>Debits <strong style={{ color: 'var(--text-primary)' }}>{fmt(debit)}</strong></span>
        <span style={{ color: 'var(--text-secondary)' }}>Credits <strong style={{ color: 'var(--text-primary)' }}>{fmt(credit)}</strong></span>
        <span style={{ color: balanced ? 'var(--success-color)' : 'var(--danger-color)', fontWeight: 700 }}>
          {balanced ? 'Balanced' : `Out by ${fmt(difference.abs())}`}
        </span>
      </div>

      {error ? (
        <div role="alert" style={{ color: 'var(--danger-color)', fontSize: '0.875rem', fontWeight: 600 }}>{error}</div>
      ) : null}

      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
        <button
          type="submit"
          disabled={submitting || !balanced}
          style={{ padding: '0.75rem 1.5rem', borderRadius: '10px', background: 'var(--accent-color)', border: 'none', color: '#fff', fontWeight: 600, cursor: submitting || !balanced ? 'not-allowed' : 'pointer', opacity: submitting || !balanced ? 0.6 : 1 }}
        >
          {submitting ? 'Posting…' : 'Post Entry'}
        </button>
        <Link href="/ledger" style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', fontWeight: 600, textDecoration: 'none' }}>
          Cancel
        </Link>
      </div>
    </form>
  );
}
