'use client';

/**
 * WiseTransferTable.tsx
 * Shows a table of recent Wise transfers with status badges and amounts.
 */

import { WiseTransferResponse } from '@/lib/types';

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  incoming_payment_waiting:  { label: 'Awaiting Payment', color: '#fbbf24', bg: 'rgba(251,191,36,0.1)' },
  processing:                { label: 'Processing',        color: '#60a5fa', bg: 'rgba(96,165,250,0.1)' },
  funds_converted:           { label: 'Converted',         color: '#a78bfa', bg: 'rgba(167,139,250,0.1)' },
  outgoing_payment_sent:     { label: 'Sent',              color: '#4ade80', bg: 'rgba(74,222,128,0.1)' },
  cancelled:                 { label: 'Cancelled',          color: '#f87171', bg: 'rgba(248,113,113,0.1)' },
  funds_refunded:            { label: 'Refunded',           color: '#fb923c', bg: 'rgba(251,146,60,0.1)' },
  failed:                    { label: 'Failed',             color: '#f87171', bg: 'rgba(248,113,113,0.1)' },
};

function fmt(value: number, currency: string) {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency, minimumFractionDigits: 2 }).format(value);
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

interface Props {
  transfers: WiseTransferResponse[];
}

export default function WiseTransferTable({ transfers }: Props) {
  if (transfers.length === 0) {
    return (
      <div style={{
        textAlign: 'center', padding: '64px 24px',
        color: '#475569', border: '1px dashed rgba(255,255,255,0.08)',
        borderRadius: '16px',
      }}>
        <div style={{ fontSize: '2.5rem', marginBottom: '12px' }}>📭</div>
        <div style={{ fontWeight: 600, color: '#94a3b8' }}>No transfers yet</div>
        <div style={{ fontSize: '0.875rem', marginTop: '4px' }}>Your payment history will appear here.</div>
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            {['ID', 'Recipient', 'You send', 'They receive', 'Status', 'Date', ''].map(h => (
              <th key={h} style={{
                textAlign: 'left', padding: '10px 14px',
                color: '#64748b', fontWeight: 600, fontSize: '0.75rem',
                textTransform: 'uppercase', letterSpacing: '0.06em',
                whiteSpace: 'nowrap',
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {transfers.map((t, i) => {
            const statusKey = t.status?.toLowerCase() ?? '';
            const badge = STATUS_CONFIG[statusKey] ?? { label: t.status, color: '#94a3b8', bg: 'rgba(148,163,184,0.1)' };

            return (
              <tr key={t.id}
                style={{
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                  background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(99,102,241,0.06)'}
                onMouseLeave={e => (e.currentTarget as HTMLTableRowElement).style.background = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)'}
              >
                <td style={{ padding: '12px 14px', color: '#64748b', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                  #{t.id}
                </td>
                <td style={{ padding: '12px 14px', color: '#e2e8f0', fontWeight: 500 }}>
                  {t.details?.reference ?? '—'}
                </td>
                <td style={{ padding: '12px 14px', color: '#f1f5f9', fontWeight: 600 }}>
                  {fmt(t.sourceValue, t.sourceCurrency)}
                </td>
                <td style={{ padding: '12px 14px', color: '#4ade80', fontWeight: 600 }}>
                  {fmt(t.targetValue, t.targetCurrency)}
                </td>
                <td style={{ padding: '12px 14px' }}>
                  <span style={{
                    display: 'inline-block', padding: '3px 10px',
                    borderRadius: '999px', fontSize: '0.7rem', fontWeight: 600,
                    color: badge.color, background: badge.bg,
                    border: `1px solid ${badge.color}40`,
                  }}>
                    {badge.label}
                  </span>
                </td>
                <td style={{ padding: '12px 14px', color: '#64748b', whiteSpace: 'nowrap' }}>
                  {fmtDate(t.created)}
                </td>
                <td style={{ padding: '12px 14px' }}>
                  <a
                    href={`https://wise.com/transactions/${t.id}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      color: '#818cf8', fontSize: '0.75rem', fontWeight: 500,
                      textDecoration: 'none', whiteSpace: 'nowrap',
                    }}
                  >
                    View →
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
