'use client';

import { useRouter, useSearchParams } from 'next/navigation';

export interface LedgerPeriodOption {
  value: string;
  label: string;
}

export default function LedgerPeriodFilter({ options }: { options: LedgerPeriodOption[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const current = searchParams.get('period') ?? 'all';

  return (
    <div style={{ display: 'flex', alignItems: 'center', background: 'var(--surface-color)', padding: '0.5rem 1rem', borderRadius: '10px', border: '1px solid var(--surface-border)', gap: '0.5rem', fontSize: '0.875rem' }}>
      <span style={{ color: 'var(--text-secondary)' }}>Period:</span>
      <select
        value={current}
        onChange={(e) => {
          const value = e.target.value;
          router.push(value === 'all' ? '/ledger' : `/ledger?period=${encodeURIComponent(value)}`);
        }}
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
