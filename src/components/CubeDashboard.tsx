'use client';

import { useMemo, useState } from 'react';
import {
  CUBE_FILTER_FIELDS,
  CUBE_ROW_CAP,
  applyCubeQuery,
  cubeRowsToCsv,
  cubeRowsToJson,
  distinctFilterValues,
  type CubeFilters,
  type CubeRow,
  type CubeSort,
} from '@/lib/kolake-cube';

const FILTER_LABEL: Record<string, string> = {
  month: 'Month',
  category: 'Category',
  party: 'Party',
  capex_opex: 'Capex/Opex',
  flow: 'Flow',
};

const COLUMNS = ['month', 'category', 'party', 'capex_opex', 'flow', 'amount', 'description'] as const;

const inputStyle: React.CSSProperties = {
  padding: '0.5rem 0.75rem',
  borderRadius: '8px',
  background: 'var(--surface-color)',
  border: '1px solid var(--surface-border)',
  color: 'var(--text-primary)',
  fontSize: '0.8125rem',
};

const btnStyle: React.CSSProperties = {
  padding: '0.5rem 1rem',
  borderRadius: '8px',
  fontWeight: 600,
  fontSize: '0.8125rem',
  cursor: 'pointer',
  border: '1px solid var(--surface-border)',
  background: 'var(--surface-color)',
  color: 'var(--text-primary)',
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
};

function triggerDownload(contents: string, filename: string, type: string) {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function CubeDashboard({ rows }: { rows: CubeRow[] }) {
  const [filters, setFilters] = useState<CubeFilters>({});
  const [sort, setSort] = useState<CubeSort | undefined>(undefined);

  const options = useMemo(() => distinctFilterValues(rows), [rows]);
  const results = useMemo(() => applyCubeQuery(rows, { filters, sort }), [rows, filters, sort]);

  const toggleSort = (field: string) => {
    setSort((prev) => {
      if (prev?.field !== field) return { field, dir: 'asc' };
      if (prev.dir === 'asc') return { field, dir: 'desc' };
      return undefined;
    });
  };

  const sortIndicator = (field: string) => (sort?.field === field ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <div>
      {/* Filters */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {CUBE_FILTER_FIELDS.map((field) => (
          <label key={field} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{FILTER_LABEL[field]}</span>
            <select
              aria-label={`Filter by ${FILTER_LABEL[field]}`}
              value={filters[field] ?? ''}
              onChange={(e) => setFilters((f) => ({ ...f, [field]: e.target.value }))}
              style={inputStyle}
            >
              <option value="">All</option>
              {options[field].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        ))}
        <button type="button" onClick={() => { setFilters({}); setSort(undefined); }} style={btnStyle}>
          Clear
        </button>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={() => triggerDownload(cubeRowsToCsv(results), 'cube_bi.csv', 'text/csv')} style={btnStyle}>
          Export CSV
        </button>
        <button type="button" onClick={() => triggerDownload(cubeRowsToJson(results), 'cube_bi.json', 'application/json')} style={btnStyle}>
          Export JSON
        </button>
      </div>

      <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
        Showing {results.length.toLocaleString()} of {rows.length.toLocaleString()} rows
        {rows.length >= CUBE_ROW_CAP ? ` (capped at ${CUBE_ROW_CAP.toLocaleString()})` : ''}
      </div>

      {/* Results table */}
      <div className="glass-card">
        <table className="premium-table">
          <thead>
            <tr>
              {COLUMNS.map((col) => (
                <th
                  key={col}
                  onClick={() => toggleSort(col)}
                  style={{ cursor: 'pointer', textAlign: col === 'amount' ? 'right' : 'left', userSelect: 'none' }}
                >
                  {FILTER_LABEL[col] ?? col.charAt(0).toUpperCase() + col.slice(1)}
                  {sortIndicator(col)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {results.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
                  No rows match the current filters.
                </td>
              </tr>
            ) : (
              results.map((row, i) => (
                <tr key={(row.id as string) ?? i}>
                  {COLUMNS.map((col) => (
                    <td key={col} data-label={col} style={{ padding: '0.75rem 1rem', textAlign: col === 'amount' ? 'right' : 'left' }}>
                      {col === 'amount' && typeof row.amount === 'number'
                        ? row.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                        : String(row[col] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
