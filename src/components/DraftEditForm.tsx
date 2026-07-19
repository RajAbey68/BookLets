'use client';

import React, { useState } from 'react';
import { updateDraftJournalEntry } from '@/app/actions/approval.actions';

interface DraftEditFormProps {
  entryId: string;
  version: number;
  initialMemo: string;
  initialDate: string;
  initialAmount: string;
  /** Only offered for the simple two-equal-line shape every automated path creates. */
  canEditAmount: boolean;
  onSaved: () => void;
  onCancel: () => void;
}

/**
 * RAJ-674 punch-list #3 — the sandbox edit form. Lets a checker correct an
 * automated DRAFT's memo/date/amount before deciding it, via the
 * version-guarded updateDraftJournalEntry action. Editing does not decide
 * the entry — approve/reject remains a separate, still 4-eyes-gated step.
 */
export default function DraftEditForm({
  entryId,
  version,
  initialMemo,
  initialDate,
  initialAmount,
  canEditAmount,
  onSaved,
  onCancel,
}: DraftEditFormProps) {
  const [memo, setMemo] = useState(initialMemo);
  const [date, setDate] = useState(initialDate.slice(0, 10)); // yyyy-mm-dd for <input type="date">
  const [amount, setAmount] = useState(initialAmount);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await updateDraftJournalEntry(entryId, version, {
        memo,
        date: new Date(`${date}T00:00:00.000Z`),
        ...(canEditAmount ? { amount } : {}),
      });
      if (!result.success) {
        setError(result.error);
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '0.5rem 0.625rem',
    borderRadius: '8px',
    border: '1px solid var(--surface-border)',
    background: 'var(--surface-color)',
    color: 'var(--text-primary)',
    fontSize: '0.8125rem',
  };
  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '0.6875rem',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: '0.25rem',
  };

  return (
    <div
      style={{
        marginTop: '1rem',
        padding: '1rem',
        borderRadius: '10px',
        border: '1px solid var(--accent-color)',
        background: 'rgba(59, 130, 246, 0.05)',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: '0.875rem',
      }}
    >
      <div>
        <label style={labelStyle} htmlFor={`memo-${entryId}`}>Memo</label>
        <input
          id={`memo-${entryId}`}
          type="text"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          style={inputStyle}
          disabled={saving}
        />
      </div>

      <div>
        <label style={labelStyle} htmlFor={`date-${entryId}`}>Date</label>
        <input
          id={`date-${entryId}`}
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          style={inputStyle}
          disabled={saving}
        />
      </div>

      <div>
        <label style={labelStyle} htmlFor={`amount-${entryId}`}>Amount</label>
        <input
          id={`amount-${entryId}`}
          type="number"
          step="0.01"
          min="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          style={inputStyle}
          disabled={saving || !canEditAmount}
          title={canEditAmount ? undefined : 'Only editable for a simple two-line entry (debit expense / credit cash).'}
        />
      </div>

      <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <button
          type="button"
          className="btn btn-primary"
          style={{ padding: '0.5rem 1rem', fontSize: '0.8125rem' }}
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save correction'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ padding: '0.5rem 1rem', fontSize: '0.8125rem' }}
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        {error && (
          <span role="alert" style={{ fontSize: '0.75rem', color: 'var(--danger-color)' }}>
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
