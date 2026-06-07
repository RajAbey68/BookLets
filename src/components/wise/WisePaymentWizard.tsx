'use client';

/**
 * WisePaymentWizard.tsx
 * 5-step guided payment flow with 4-Eyes review gate.
 *
 * Steps:
 *   1. Select Profile
 *   2. Recipient details
 *   3. Amount + live quote
 *   4. 4-Eyes review (confirm + optional ledger account selection)
 *   5. Result (success / error)
 */

import { useState, useTransition } from 'react';
import { WiseApiProfile, WiseBalance, PaymentInitiatePayload } from '@/lib/types';
import type { InitiatedPayment } from '@/app/actions/wise.actions';

interface LedgerAccount {
  id: string;
  name: string;
  code: string;
}

interface Props {
  profiles: WiseApiProfile[];
  balances: WiseBalance[];
  organizationId: string;
  ledgerAccounts?: LedgerAccount[];
  onClose: () => void;
  // Server action refs passed from server component / page
  initiatePaymentAction: (payload: PaymentInitiatePayload, orgId: string) => Promise<{ ok: true; payment: InitiatedPayment } | { ok: false; error: string }>;
  confirmPaymentAction: (payload: {
    transferId: number; localTransferId: string; profileId: number;
    organizationId: string; debitAccountId?: string; creditAccountId?: string;
  }) => Promise<{ ok: true; wiseStatus: string; journalEntryId?: string } | { ok: false; error: string }>;
}

const COMMON_CURRENCIES = ['GBP', 'USD', 'EUR', 'AUD', 'CAD', 'CHF', 'JPY', 'SGD', 'NZD', 'AED', 'INR', 'ZAR'];

const inputStyle = {
  width: '100%', padding: '10px 14px', borderRadius: '10px',
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.05)',
  color: '#f1f5f9', fontSize: '0.875rem', outline: 'none',
  boxSizing: 'border-box' as const,
};

const labelStyle = {
  display: 'block', fontSize: '0.75rem', fontWeight: 600,
  color: '#94a3b8', marginBottom: '6px', textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
};

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '28px' }}>
      {Array.from({ length: total }, (_, i) => (
        <div key={i} style={{
          flex: i === current - 1 ? 2 : 1, height: '4px', borderRadius: '2px',
          background: i < current
            ? 'linear-gradient(90deg, #6366f1, #8b5cf6)'
            : 'rgba(255,255,255,0.1)',
          transition: 'all 0.3s ease',
        }} />
      ))}
    </div>
  );
}

export default function WisePaymentWizard({
  profiles, balances, organizationId, ledgerAccounts = [],
  onClose, initiatePaymentAction, confirmPaymentAction,
}: Props) {
  const [step, setStep] = useState(1);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState('');

  // Step 1 — Profile
  const [selectedProfileId, setSelectedProfileId] = useState<number | null>(
    profiles.find(p => p.type === 'business')?.id ?? profiles[0]?.id ?? null
  );

  // Step 2 — Recipient
  const [recipientName, setRecipientName] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [iban, setIban] = useState('');
  const [targetCurrency, setTargetCurrency] = useState('EUR');

  // Step 3 — Amount
  const [sourceAmount, setSourceAmount] = useState('');
  const [sourceCurrency, setSourceCurrency] = useState(balances[0]?.currency ?? 'GBP');
  const [reference, setReference] = useState('');

  // Step 4 — Initiated payment (returned by server)
  const [initiated, setInitiated] = useState<InitiatedPayment | null>(null);
  const [postToLedger, setPostToLedger] = useState(false);
  const [debitAccountId, setDebitAccountId] = useState('');
  const [creditAccountId, setCreditAccountId] = useState('');

  // Step 5 — Result
  const [result, setResult] = useState<{ status: string; journalEntryId?: string } | null>(null);

  function nextStep() { setError(''); setStep(s => s + 1); }
  function prevStep() { setError(''); setStep(s => s - 1); }

  // ── Step 3 → 4: Initiate (get quote + create transfer) ──────────────────
  function handleInitiate() {
    if (!selectedProfileId) return;
    setError('');
    startTransition(async () => {
      const res = await initiatePaymentAction(
        {
          profileId: selectedProfileId,
          sourceCurrency,
          targetCurrency,
          sourceAmount: parseFloat(sourceAmount),
          recipientName,
          recipientEmail: recipientEmail || undefined,
          iban: iban || undefined,
          reference: reference || undefined,
        },
        organizationId
      );
      if (!res.ok) { setError(res.error); return; }
      setInitiated(res.payment);
      setStep(4);
    });
  }

  // ── Step 4 → 5: Confirm (fund transfer) ─────────────────────────────────
  function handleConfirm() {
    if (!initiated || !selectedProfileId) return;
    setError('');
    startTransition(async () => {
      const res = await confirmPaymentAction({
        transferId: initiated.wiseTransferId,
        localTransferId: initiated.localTransferId,
        profileId: selectedProfileId,
        organizationId,
        debitAccountId: postToLedger ? debitAccountId : undefined,
        creditAccountId: postToLedger ? creditAccountId : undefined,
      });
      if (!res.ok) { setError(res.error); return; }
      setResult({ status: res.wiseStatus, journalEntryId: res.journalEntryId });
      setStep(5);
    });
  }

  const overlay: React.CSSProperties = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
    backdropFilter: 'blur(4px)', zIndex: 100,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '24px',
  };
  const card: React.CSSProperties = {
    background: 'linear-gradient(145deg, #0f172a 0%, #1e293b 100%)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '20px',
    padding: '36px',
    width: '100%', maxWidth: '520px',
    maxHeight: '90vh', overflowY: 'auto',
    position: 'relative',
  };

  function fmt(v: number, c: string) {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: c, minimumFractionDigits: 2 }).format(v);
  }

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={card}>
        {/* Close */}
        <button onClick={onClose} style={{
          position: 'absolute', top: '20px', right: '20px',
          background: 'none', border: 'none', color: '#64748b',
          cursor: 'pointer', fontSize: '1.25rem', lineHeight: 1,
        }}>✕</button>

        <h2 style={{ margin: '0 0 6px', color: '#f1f5f9', fontSize: '1.25rem', fontWeight: 700 }}>
          Send Money
        </h2>
        <p style={{ margin: '0 0 24px', color: '#64748b', fontSize: '0.875rem' }}>
          Step {step} of 5
        </p>

        <StepIndicator current={step} total={5} />

        {/* ── Step 1: Profile ── */}
        {step === 1 && (
          <div>
            <h3 style={{ color: '#e2e8f0', marginBottom: '20px' }}>Select Wise Profile</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {profiles.map(p => {
                const name = p.type === 'business'
                  ? (p.details.name ?? 'Business')
                  : `${p.details.firstName ?? ''} ${p.details.lastName ?? ''}`.trim();
                const selected = selectedProfileId === p.id;
                return (
                  <button key={p.id} onClick={() => setSelectedProfileId(p.id)} style={{
                    textAlign: 'left', padding: '16px 20px', borderRadius: '12px',
                    border: selected ? '2px solid #6366f1' : '1px solid rgba(255,255,255,0.1)',
                    background: selected ? 'rgba(99,102,241,0.12)' : 'rgba(255,255,255,0.03)',
                    color: '#f1f5f9', cursor: 'pointer', transition: 'all 0.2s',
                  }}>
                    <div style={{ fontWeight: 700 }}>{name}</div>
                    <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '4px', textTransform: 'capitalize' }}>
                      {p.type} · ID {p.id}
                    </div>
                  </button>
                );
              })}
            </div>
            <button onClick={nextStep} disabled={!selectedProfileId} style={{
              marginTop: '24px', width: '100%', padding: '12px',
              borderRadius: '12px', border: 'none', fontWeight: 700,
              background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              color: '#fff', cursor: 'pointer', fontSize: '0.9rem',
            }}>
              Continue →
            </button>
          </div>
        )}

        {/* ── Step 2: Recipient ── */}
        {step === 2 && (
          <div>
            <h3 style={{ color: '#e2e8f0', marginBottom: '20px' }}>Recipient Details</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={labelStyle}>Full Name *</label>
                <input value={recipientName} onChange={e => setRecipientName(e.target.value)}
                  placeholder="Jane Smith" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Email (optional)</label>
                <input value={recipientEmail} onChange={e => setRecipientEmail(e.target.value)}
                  placeholder="jane@example.com" type="email" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>IBAN (optional)</label>
                <input value={iban} onChange={e => setIban(e.target.value)}
                  placeholder="GB29NWBK60161331926819" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Receive Currency *</label>
                <select value={targetCurrency} onChange={e => setTargetCurrency(e.target.value)}
                  style={{ ...inputStyle }}>
                  {COMMON_CURRENCIES.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '12px', marginTop: '24px' }}>
              <button onClick={prevStep} style={{
                flex: 1, padding: '12px', borderRadius: '12px', fontWeight: 600,
                border: '1px solid rgba(255,255,255,0.1)',
                background: 'transparent', color: '#94a3b8', cursor: 'pointer',
              }}>← Back</button>
              <button onClick={nextStep} disabled={!recipientName} style={{
                flex: 2, padding: '12px', borderRadius: '12px', border: 'none',
                fontWeight: 700, background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                color: '#fff', cursor: !recipientName ? 'not-allowed' : 'pointer',
                opacity: !recipientName ? 0.5 : 1,
              }}>
                Continue →
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3: Amount ── */}
        {step === 3 && (
          <div>
            <h3 style={{ color: '#e2e8f0', marginBottom: '20px' }}>Amount & Reference</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={labelStyle}>Send Currency</label>
                <select value={sourceCurrency} onChange={e => setSourceCurrency(e.target.value)} style={{ ...inputStyle }}>
                  {balances.map(b => (
                    <option key={b.currency} value={b.currency}>
                      {b.currency} — {new Intl.NumberFormat('en-GB', { style: 'currency', currency: b.currency }).format(b.amount.value)} available
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Amount ({sourceCurrency}) *</label>
                <input value={sourceAmount} onChange={e => setSourceAmount(e.target.value)}
                  placeholder="500.00" type="number" min="1" step="0.01" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Reference (optional)</label>
                <input value={reference} onChange={e => setReference(e.target.value)}
                  placeholder="Invoice #1234" style={inputStyle} />
              </div>
            </div>

            {error && (
              <div style={{
                marginTop: '16px', padding: '12px 16px', borderRadius: '10px',
                background: 'rgba(248,113,113,0.1)', color: '#f87171',
                border: '1px solid rgba(248,113,113,0.3)', fontSize: '0.85rem',
              }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: '12px', marginTop: '24px' }}>
              <button onClick={prevStep} style={{
                flex: 1, padding: '12px', borderRadius: '12px', fontWeight: 600,
                border: '1px solid rgba(255,255,255,0.1)',
                background: 'transparent', color: '#94a3b8', cursor: 'pointer',
              }}>← Back</button>
              <button onClick={handleInitiate}
                disabled={isPending || !sourceAmount || parseFloat(sourceAmount) <= 0}
                style={{
                  flex: 2, padding: '12px', borderRadius: '12px', border: 'none',
                  fontWeight: 700,
                  background: isPending ? 'rgba(99,102,241,0.4)' : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                  color: '#fff', cursor: isPending ? 'wait' : 'pointer',
                }}>
                {isPending ? 'Getting quote…' : 'Get Quote →'}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 4: 4-Eyes Review ── */}
        {step === 4 && initiated && (
          <div>
            <h3 style={{ color: '#e2e8f0', marginBottom: '6px' }}>Review Transfer</h3>
            <p style={{ color: '#64748b', fontSize: '0.8rem', marginBottom: '20px' }}>
              Please review carefully before confirming. This will move real funds.
            </p>

            {/* Summary card */}
            <div style={{
              background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.25)',
              borderRadius: '14px', padding: '20px',
              display: 'flex', flexDirection: 'column', gap: '12px',
            }}>
              {[
                ['You send', `${fmt(initiated.quote.sourceAmount, initiated.quote.sourceCurrency)}`],
                ['They receive', `${fmt(initiated.quote.targetAmount, initiated.quote.targetCurrency)}`],
                ['Exchange rate', `1 ${initiated.quote.sourceCurrency} = ${initiated.quote.rate.toFixed(4)} ${initiated.quote.targetCurrency}`],
                ['Wise fee', `${fmt(initiated.quote.fee, initiated.quote.sourceCurrency)}`],
                ['Estimated arrival', initiated.quote.estimatedDelivery],
                ['Recipient', recipientName],
                ['Reference', reference || '—'],
              ].map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: '#64748b', fontSize: '0.8rem' }}>{k}</span>
                  <span style={{ color: '#f1f5f9', fontWeight: 600, fontSize: '0.875rem' }}>{v}</span>
                </div>
              ))}
            </div>

            {/* Manual ledger posting toggle */}
            <div style={{ marginTop: '20px', padding: '16px', borderRadius: '12px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={postToLedger}
                  onChange={e => setPostToLedger(e.target.checked)}
                  style={{ width: '16px', height: '16px', accentColor: '#6366f1' }}
                />
                <div>
                  <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.875rem' }}>Post to Ledger</div>
                  <div style={{ color: '#64748b', fontSize: '0.75rem' }}>Create a double-entry journal entry for this payment</div>
                </div>
              </label>

              {postToLedger && ledgerAccounts.length > 0 && (
                <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div>
                    <label style={labelStyle}>Debit Account (e.g. Accounts Payable)</label>
                    <select value={debitAccountId} onChange={e => setDebitAccountId(e.target.value)} style={{ ...inputStyle }}>
                      <option value="">Select account…</option>
                      {ledgerAccounts.map(a => (
                        <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Credit Account (e.g. Wise Bank)</label>
                    <select value={creditAccountId} onChange={e => setCreditAccountId(e.target.value)} style={{ ...inputStyle }}>
                      <option value="">Select account…</option>
                      {ledgerAccounts.map(a => (
                        <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
              {postToLedger && ledgerAccounts.length === 0 && (
                <div style={{ marginTop: '12px', color: '#fbbf24', fontSize: '0.8rem' }}>
                  No GL accounts found. Add accounts in the Chart of Accounts first.
                </div>
              )}
            </div>

            {error && (
              <div style={{
                marginTop: '16px', padding: '12px 16px', borderRadius: '10px',
                background: 'rgba(248,113,113,0.1)', color: '#f87171',
                border: '1px solid rgba(248,113,113,0.3)', fontSize: '0.85rem',
              }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: '12px', marginTop: '24px' }}>
              <button onClick={prevStep} style={{
                flex: 1, padding: '12px', borderRadius: '12px', fontWeight: 600,
                border: '1px solid rgba(255,255,255,0.1)',
                background: 'transparent', color: '#94a3b8', cursor: 'pointer',
              }}>← Back</button>
              <button onClick={handleConfirm} disabled={isPending} style={{
                flex: 2, padding: '12px', borderRadius: '12px', border: 'none',
                fontWeight: 700,
                background: isPending ? 'rgba(99,102,241,0.4)' : 'linear-gradient(135deg, #10b981, #059669)',
                color: '#fff', cursor: isPending ? 'wait' : 'pointer',
              }}>
                {isPending ? 'Confirming…' : '✓ Confirm & Send'}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 5: Result ── */}
        {step === 5 && result && (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <div style={{ fontSize: '3.5rem', marginBottom: '16px' }}>
              {result.status.includes('cancel') || result.status.includes('fail') ? '❌' : '✅'}
            </div>
            <h3 style={{ color: '#f1f5f9', marginBottom: '8px' }}>
              {result.status.includes('cancel') || result.status.includes('fail')
                ? 'Transfer failed'
                : 'Transfer initiated!'}
            </h3>
            <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginBottom: '20px' }}>
              Wise status: <strong style={{ color: '#e2e8f0' }}>{result.status}</strong>
            </p>
            {result.journalEntryId && (
              <div style={{
                padding: '12px 16px', borderRadius: '10px',
                background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.2)',
                color: '#4ade80', fontSize: '0.8rem', marginBottom: '20px',
              }}>
                📒 Journal entry posted · ID {result.journalEntryId.slice(0, 12)}…
              </div>
            )}
            <button onClick={onClose} style={{
              padding: '12px 32px', borderRadius: '12px', border: 'none',
              fontWeight: 700, background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              color: '#fff', cursor: 'pointer',
            }}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
