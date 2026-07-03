'use client';

import { useRouter, useSearchParams } from 'next/navigation';

export interface PLPeriodOption {
  value: string;
  label: string;
}

/**
 * RAJ-289 — MTD/QTD/YTD selector for the P&L report. Mirrors
 * LedgerPeriodFilter but routes back to /reports/pl and defaults to MTD.
 */
export default function PLPeriodFilter({ options }: { options: readonly PLPeriodOption[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const current = searchParams.get('period') ?? 'MTD';

  return (
    <div style={{ display: 'flex', alignItems: 'center', background: 'var(--surface-color)', padding: '0.5rem 1rem', borderRadius: '10px', border: '1px solid var(--surface-border)', gap: '0.5rem', fontSize: '0.875rem' }}>
      <span style={{ color: 'var(--text-secondary)' }}>Period:</span>
      <select
        value={current}
        onChange={(e) => router.push(`/reports/pl?period=${encodeURIComponent(e.target.value)}`)}
        style={{ background: 'none', border: 'none', color: 'var(--text-primary)', outline: 'none', fontWeight: '600', cursor: 'pointer' }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} style={{ background: 'var(--surface-color)', color: 'var(--text-primary)' }}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
