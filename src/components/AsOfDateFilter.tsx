'use client';

import { useRouter, usePathname } from 'next/navigation';

/**
 * RAJ-290 — "As of" date selector for stock reports (Balance Sheet).
 *
 * Unlike LedgerPeriodFilter (a month window for flow reports), a balance
 * sheet needs a single cut-off date. Pushes ?asOf=YYYY-MM-DD onto the current
 * pathname so the server component re-renders with the new date.
 *
 * Displays the APPLIED as-of date from the server (not the raw URL param):
 * an invalid ?asOf= falls back to today server-side, and the widget must
 * agree with the data actually shown (adversarial-review point adopted).
 */
export default function AsOfDateFilter({ asOf }: { asOf: string }) {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <div style={{ display: 'flex', alignItems: 'center', background: 'var(--surface-color)', padding: '0.5rem 1rem', borderRadius: '10px', border: '1px solid var(--surface-border)', gap: '0.5rem', fontSize: '0.875rem' }}>
      <label htmlFor="as-of-date" style={{ color: 'var(--text-secondary)' }}>As of:</label>
      <input
        id="as-of-date"
        type="date"
        value={asOf}
        onChange={(e) => {
          const value = e.target.value;
          router.push(value ? `${pathname}?asOf=${encodeURIComponent(value)}` : pathname);
        }}
        style={{ background: 'none', border: 'none', color: 'var(--text-primary)', outline: 'none', fontWeight: 600, cursor: 'pointer', colorScheme: 'dark' }}
      />
    </div>
  );
}
