'use client';

import { useState, useTransition } from 'react';
import { parseUploadedSpreadsheet } from '@/app/actions/spreadsheet-import.actions';
import type { ParseResult, ParsedRow, Section } from '@/lib/spreadsheet-parser';

const SECTION_LABELS: Record<Section, string> = {
  'prior-month':         'Prior-Month Catch-up',
  'daily':               'Daily Transactions',
  'recurring':           'Recurring Expenses',
  'accruals':            'Accruals',
  'accrual-reversals':   'Accrual Reversals',
  'prepayments':         'Prepayments',
  'prepayment-reversals': 'Prepayment Reversals',
  'unknown':             'Unclassified',
};

const SECTION_ORDER: Section[] = [
  'prior-month', 'daily', 'recurring', 'accruals',
  'accrual-reversals', 'prepayments', 'prepayment-reversals', 'unknown',
];

function fmtAmount(value: { toFixed: (n: number) => string }): string {
  return value.toFixed(2);
}

function fmtDate(d: Date | string | null): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toISOString().slice(0, 10);
}

export default function SpreadsheetImporter() {
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const res = await parseUploadedSpreadsheet(formData);
      if (res.ok && res.result) {
        setParsed(res.result);
      } else {
        setParsed(null);
        setError(res.error ?? 'Unknown error');
      }
    });
  }

  function reset() {
    setParsed(null);
    setError(null);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <form
        onSubmit={handleSubmit}
        className="glass-card"
        style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}
      >
        <div>
          <h3 style={{ marginBottom: '0.25rem' }}>Upload monthly workbook</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', margin: 0 }}>
            Drop the Income &amp; Petty Cash Analysis <code>.xlsx</code> for the month.
            The parser will preview rows and totals — nothing is posted to the ledger until you confirm in the next step.
          </p>
        </div>
        <input
          type="file"
          name="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          required
          disabled={pending}
          style={{ fontSize: '0.875rem' }}
        />
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            type="submit"
            className="btn-primary"
            disabled={pending}
            style={{
              padding: '0.625rem 1.25rem',
              borderRadius: '8px',
              background: 'var(--accent-color)',
              border: 'none',
              color: '#fff',
              fontWeight: 600,
              fontSize: '0.875rem',
              cursor: pending ? 'wait' : 'pointer',
              opacity: pending ? 0.7 : 1,
            }}
          >
            {pending ? 'Parsing…' : 'Parse'}
          </button>
          {parsed ? (
            <button
              type="button"
              onClick={reset}
              style={{
                padding: '0.625rem 1.25rem',
                borderRadius: '8px',
                background: 'transparent',
                border: '1px solid var(--surface-border)',
                color: 'var(--text-secondary)',
                fontWeight: 600,
                fontSize: '0.875rem',
                cursor: 'pointer',
              }}
            >
              Upload another
            </button>
          ) : null}
        </div>
        {error ? (
          <div
            role="alert"
            style={{
              padding: '0.75rem 1rem',
              borderRadius: '6px',
              border: '1px solid var(--danger-color, #b91c1c)',
              color: 'var(--danger-color, #b91c1c)',
              fontSize: '0.875rem',
            }}
          >
            {error}
          </div>
        ) : null}
      </form>

      {parsed ? <ParsePreview result={parsed} /> : null}
    </div>
  );
}

function ParsePreview({ result }: { result: ParseResult }) {
  const grouped = new Map<Section, ParsedRow[]>();
  for (const row of result.rows) {
    const list = grouped.get(row.section) ?? [];
    list.push(row);
    grouped.set(row.section, list);
  }

  const rowsWithWarnings = result.rows.filter((r) => r.warnings.length > 0);

  return (
    <>
      <div className="glass-card" style={{ padding: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
          <h3 style={{ margin: 0 }}>
            {result.periodLabel} — {result.rows.length} rows parsed
          </h3>
          <code style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            sha256 {result.fileHash.slice(0, 12)}…
          </code>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', margin: 0 }}>
          Net (income − expense): <strong>LKR {fmtAmount(result.netAmount)}</strong> ·{' '}
          {rowsWithWarnings.length} row{rowsWithWarnings.length === 1 ? '' : 's'} with warnings ·{' '}
          {result.unmappedColumns.length} unmapped column{result.unmappedColumns.length === 1 ? '' : 's'}
        </p>
      </div>

      <PerSectionTotals result={result} />

      {result.unmappedColumns.length > 0 ? (
        <div className="glass-card" style={{ padding: '1.5rem', borderColor: '#b45309' }}>
          <h4 style={{ margin: '0 0 0.5rem 0', color: '#b45309' }}>Unmapped columns</h4>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', margin: '0 0 0.75rem 0' }}>
            These spreadsheet column headers don&apos;t map to any account in the chart. Amounts in these columns were ignored.
          </p>
          <ul style={{ fontFamily: 'monospace', fontSize: '0.8125rem', margin: 0, paddingLeft: '1.25rem' }}>
            {result.unmappedColumns.map((h) => <li key={h}>{h}</li>)}
          </ul>
        </div>
      ) : null}

      {SECTION_ORDER.filter((s) => grouped.has(s)).map((section) => (
        <SectionTable key={section} section={section} rows={grouped.get(section)!} />
      ))}
    </>
  );
}

function PerSectionTotals({ result }: { result: ParseResult }) {
  const sectionsWithData = SECTION_ORDER.filter(
    (s) => Object.keys(result.totalsBySection[s]).length > 0,
  );
  if (sectionsWithData.length === 0) return null;

  return (
    <div className="glass-card" style={{ padding: '1.5rem' }}>
      <h4 style={{ margin: '0 0 1rem 0' }}>Totals by account, per section</h4>
      <div style={{ display: 'grid', gap: '1.25rem' }}>
        {sectionsWithData.map((section) => {
          const totals = result.totalsBySection[section];
          const entries = Object.entries(totals).sort(([a], [b]) => a.localeCompare(b));
          return (
            <div key={section}>
              <div style={{ fontWeight: 600, fontSize: '0.8125rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--accent-color)', marginBottom: '0.5rem' }}>
                {SECTION_LABELS[section]}
              </div>
              <table className="premium-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ width: '10ch' }}>Account</th>
                    <th style={{ textAlign: 'right' }}>Total (LKR)</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(([code, amt]) => (
                    <tr key={code}>
                      <td><code>{code}</code></td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {fmtAmount(amt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SectionTable({ section, rows }: { section: Section; rows: ParsedRow[] }) {
  return (
    <div className="glass-card" style={{ padding: '1.5rem' }}>
      <h4 style={{ margin: '0 0 0.75rem 0' }}>
        {SECTION_LABELS[section]}{' '}
        <span style={{ color: 'var(--text-secondary)', fontWeight: 400, fontSize: '0.875rem' }}>
          ({rows.length} rows)
        </span>
      </h4>
      <div style={{ overflowX: 'auto' }}>
        <table className="premium-table" style={{ width: '100%', fontSize: '0.8125rem' }}>
          <thead>
            <tr>
              <th style={{ width: '11ch' }}>Date</th>
              <th>Description</th>
              <th style={{ textAlign: 'right', width: '14ch' }}>Petty Cash</th>
              <th>Postings</th>
              <th style={{ width: '24ch' }}>Warnings</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.rowId}>
                <td style={{ whiteSpace: 'nowrap', color: row.dateForwardFilled ? '#b45309' : undefined }}>
                  {fmtDate(row.date)}
                  {row.dateForwardFilled ? '*' : ''}
                </td>
                <td>{row.description || <em style={{ color: 'var(--text-secondary)' }}>(none)</em>}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {row.pettyCashTopUp ? fmtAmount(row.pettyCashTopUp) : ''}
                </td>
                <td>
                  {row.amounts.length === 0
                    ? <span style={{ color: 'var(--text-secondary)' }}>—</span>
                    : (
                        <ul style={{ margin: 0, paddingLeft: '1rem', fontSize: '0.8125rem' }}>
                          {row.amounts.map((a, i) => (
                            <li key={i}>
                              <code>{a.accountCode ?? '???'}</code> {a.columnHeader}: {fmtAmount(a.amount)}
                            </li>
                          ))}
                        </ul>
                      )}
                </td>
                <td style={{ fontSize: '0.75rem', color: row.warnings.length > 0 ? '#b45309' : 'var(--text-secondary)' }}>
                  {row.warnings.length > 0 ? row.warnings.join('; ') : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.5rem', marginBottom: 0 }}>
        Dates marked with <span style={{ color: '#b45309' }}>*</span> were forward-filled from a previous row.
      </p>
    </div>
  );
}
