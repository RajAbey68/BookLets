'use client';

/**
 * WiseBalanceCard.tsx
 * Displays a single Wise multi-currency balance with flag, amount, and CTA.
 */

import { WiseBalance } from '@/lib/types';

const CURRENCY_FLAGS: Record<string, string> = {
  GBP: '🇬🇧', USD: '🇺🇸', EUR: '🇪🇺', AUD: '🇦🇺', CAD: '🇨🇦',
  CHF: '🇨🇭', JPY: '🇯🇵', NZD: '🇳🇿', SGD: '🇸🇬', HKD: '🇭🇰',
  NOK: '🇳🇴', SEK: '🇸🇪', DKK: '🇩🇰', PLN: '🇵🇱', CZK: '🇨🇿',
  HUF: '🇭🇺', RON: '🇷🇴', BGN: '🇧🇬', HRK: '🇭🇷', TRY: '🇹🇷',
  AED: '🇦🇪', ZAR: '🇿🇦', INR: '🇮🇳', MXN: '🇲🇽', BRL: '🇧🇷',
  MYR: '🇲🇾', PHP: '🇵🇭', THB: '🇹🇭', IDR: '🇮🇩', KRW: '🇰🇷',
};

const CURRENCY_NAMES: Record<string, string> = {
  GBP: 'British Pound', USD: 'US Dollar', EUR: 'Euro',
  AUD: 'Australian Dollar', CAD: 'Canadian Dollar', CHF: 'Swiss Franc',
  JPY: 'Japanese Yen', NZD: 'New Zealand Dollar', SGD: 'Singapore Dollar',
  HKD: 'Hong Kong Dollar', NOK: 'Norwegian Krone', SEK: 'Swedish Krona',
  DKK: 'Danish Krone', PLN: 'Polish Złoty', TRY: 'Turkish Lira',
  AED: 'UAE Dirham', ZAR: 'South African Rand', INR: 'Indian Rupee',
  MXN: 'Mexican Peso', BRL: 'Brazilian Real',
};

function formatAmount(value: number, currency: string) {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value);
}

interface Props {
  balance: WiseBalance;
  onSend?: (balance: WiseBalance) => void;
}

export default function WiseBalanceCard({ balance, onSend }: Props) {
  const flag = CURRENCY_FLAGS[balance.currency] ?? '🏦';
  const name = CURRENCY_NAMES[balance.currency] ?? balance.currency;
  const amount = balance.amount.value;
  const reserved = balance.reservedAmount.value;
  const isZero = amount === 0;
  const hasBankDetails = !!balance.bankDetails;

  return (
    <div style={{
      background: 'linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%)',
      border: '1px solid rgba(255,255,255,0.1)',
      borderRadius: '16px',
      padding: '24px',
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
      backdropFilter: 'blur(12px)',
      transition: 'transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease',
      cursor: 'default',
      position: 'relative',
      overflow: 'hidden',
    }}
    onMouseEnter={e => {
      (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-2px)';
      (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(99, 102, 241, 0.4)';
      (e.currentTarget as HTMLDivElement).style.boxShadow = '0 8px 32px rgba(99, 102, 241, 0.15)';
    }}
    onMouseLeave={e => {
      (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)';
      (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,255,255,0.1)';
      (e.currentTarget as HTMLDivElement).style.boxShadow = 'none';
    }}
    >
      {/* Glow accent */}
      <div style={{
        position: 'absolute', top: '-40px', right: '-40px',
        width: '120px', height: '120px',
        borderRadius: '50%',
        background: isZero
          ? 'rgba(107, 114, 128, 0.08)'
          : 'rgba(99, 102, 241, 0.12)',
        pointerEvents: 'none',
      }} />

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{ fontSize: '2rem', lineHeight: 1 }}>{flag}</span>
        <div>
          <div style={{ fontWeight: 700, fontSize: '1rem', color: '#f1f5f9' }}>
            {balance.currency}
          </div>
          <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>{name}</div>
        </div>
        {hasBankDetails && (
          <span style={{
            marginLeft: 'auto', fontSize: '0.65rem', fontWeight: 600,
            padding: '2px 8px', borderRadius: '999px',
            background: 'rgba(34, 197, 94, 0.15)', color: '#4ade80',
            border: '1px solid rgba(34, 197, 94, 0.3)',
          }}>
            IBAN
          </span>
        )}
      </div>

      {/* Balance */}
      <div>
        <div style={{
          fontSize: '1.75rem', fontWeight: 800,
          color: isZero ? '#64748b' : '#f1f5f9',
          letterSpacing: '-0.02em',
        }}>
          {formatAmount(amount, balance.currency)}
        </div>
        {reserved > 0 && (
          <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '4px' }}>
            {formatAmount(reserved, balance.currency)} reserved
          </div>
        )}
      </div>

      {/* IBAN preview */}
      {balance.bankDetails?.iban && (
        <div style={{
          fontSize: '0.7rem', color: '#64748b', fontFamily: 'monospace',
          background: 'rgba(255,255,255,0.03)', borderRadius: '8px',
          padding: '6px 10px', letterSpacing: '0.05em',
        }}>
          {balance.bankDetails.iban.replace(/(.{4})/g, '$1 ').trim()}
        </div>
      )}

      {/* CTA */}
      <button
        onClick={() => onSend?.(balance)}
        disabled={isZero}
        style={{
          background: isZero
            ? 'rgba(255,255,255,0.05)'
            : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
          color: isZero ? '#475569' : '#fff',
          border: 'none',
          borderRadius: '10px',
          padding: '10px 0',
          fontWeight: 600,
          fontSize: '0.875rem',
          cursor: isZero ? 'not-allowed' : 'pointer',
          transition: 'opacity 0.2s',
          width: '100%',
        }}
        onMouseEnter={e => { if (!isZero) (e.currentTarget as HTMLButtonElement).style.opacity = '0.85'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '1'; }}
      >
        {isZero ? 'No funds' : 'Send from this balance'}
      </button>
    </div>
  );
}
