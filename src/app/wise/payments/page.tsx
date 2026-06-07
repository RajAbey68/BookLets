'use client';
import { useState, useEffect, useCallback } from 'react';
import { getWiseQuote, getWiseProfiles, initiateWisePayment, createWiseRecipient } from '../../actions/wise.actions';
import { getDefaultOrganizationId } from '../../actions/sync.actions';
import type { WiseApiProfile } from '@/lib/types';

const CURRENCIES = ['EUR','USD','GBP','CHF','AUD','CAD','JPY','SGD','HKD','NZD','NOK','SEK','DKK','PLN','BRL','INR','ZAR','AED','MXN','THB'];
const STEPS = ['Amount','Recipient','Review','Confirm'];

function Stepper({ step }: { step: number }) {
  return (
    <div className="payment-stepper">
      {STEPS.map((label, i) => (
        <div key={label} className={`payment-step-item${i < step ? ' completed' : i === step ? ' active' : ''}`}>
          <div className="payment-step-circle">{i < step ? '✓' : i + 1}</div>
          <div className="payment-step-label">{label}</div>
        </div>
      ))}
    </div>
  );
}

export default function WisePaymentsPage() {
  const [step, setStep] = useState(0);
  const [profiles, setProfiles] = useState<WiseApiProfile[]>([]);
  const [profileId, setProfileId] = useState<number | null>(null);

  // Step 0 — Amount
  const [srcCurrency, setSrcCurrency] = useState('EUR');
  const [tgtCurrency, setTgtCurrency] = useState('GBP');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<{ rate: number; fee: number; targetAmount: number; estimatedDelivery: string; quoteId: string } | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState('');

  // Step 1 — Recipient
  const [recipientName, setRecipientName] = useState('');
  const [recipientType, setRecipientType] = useState('iban');
  const [iban, setIban] = useState('');
  const [sortCode, setSortCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [recipientId, setRecipientId] = useState<number | null>(null);

  // Step 2/3 — Confirm
  const [reference, setReference] = useState('');
  const [autoJournal, setAutoJournal] = useState(true);
  const [debitAccountId, setDebitAccountId] = useState('');
  const [creditAccountId, setCreditAccountId] = useState('');
  const [orgId, setOrgId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<{ transferId: number; journalEntryId: string | null; status: string } | null>(null);

  // Load profiles + default org ID on mount
  useEffect(() => {
    getWiseProfiles().then(r => {
      if (r.success) {
        setProfiles(r.data);
        if (r.data.length > 0) setProfileId(r.data[0].id);
      }
    });
    getDefaultOrganizationId().then(id => {
      if (id) setOrgId(id);
      else console.warn('[WisePayments] No organisation found in DB. Journal auto-posting will be disabled.');
    });
  }, []);

  const profileLabel = (p: WiseApiProfile) =>
    p.type === 'business'
      ? `🏢 ${p.details.name ?? 'Business'}`
      : `👤 ${p.details.firstName ?? ''} ${p.details.lastName ?? ''}`.trim();

  const fetchQuote = useCallback(async () => {
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) return;
    setQuoteLoading(true); setQuoteError('');
    const r = await getWiseQuote(srcCurrency, tgtCurrency, Number(amount));
    if (r.success) setQuote(r.data);
    else setQuoteError(r.error);
    setQuoteLoading(false);
  }, [amount, srcCurrency, tgtCurrency]);

  // Step 1: create recipient then advance
  const handleRecipient = async () => {
    setBusy(true); setError('');
    const details: Record<string, string> = recipientType === 'iban'
      ? { IBAN: iban }
      : { sortCode, accountNumber };
    const r = await createWiseRecipient({ currency: tgtCurrency, type: recipientType, accountHolderName: recipientName, details: recipientType === 'iban' ? { IBAN: iban } : { sortCode, accountNumber } });
    if (r.success) { setRecipientId(r.data.id); setStep(2); }
    else setError(r.error);
    setBusy(false);
  };

  // Step 3: confirm & send
  const handleSend = async () => {
    if (!quote || !recipientId || !profileId) return;
    if (!orgId) {
      setError('No organisation found in the database. Please seed the DB or set up an organisation first.');
      return;
    }
    setBusy(true); setError('');
    const r = await initiateWisePayment({
      quoteId: quote.quoteId,
      recipientId,
      reference: reference || undefined,
      debitAccountId: autoJournal ? debitAccountId : '__skip__',
      creditAccountId: autoJournal ? creditAccountId : '__skip__',
      organizationId: orgId,
      sourceAmount: Number(amount),
      sourceCurrency: srcCurrency,
      targetCurrency: tgtCurrency,
    });
    if (r.success) setSuccess(r.data);
    else setError(r.error);
    setBusy(false);
  };

  // ── Success screen
  if (success) {
    return (
      <div style={{ maxWidth: '540px', margin: '0 auto', textAlign: 'center' }}>
        <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>✅</div>
        <h1 style={{ color: 'var(--wise-green)', marginBottom: '0.5rem' }}>Payment Sent!</h1>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem' }}>Your transfer has been submitted to Wise.</p>
        <div className="glass-card" style={{ textAlign: 'left', marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Transfer ID</span>
              <strong>#{success.transferId}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Status</span>
              <strong style={{ color: 'var(--wise-green)' }}>{success.status?.replace(/_/g, ' ')}</strong>
            </div>
            {success.journalEntryId && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Journal Entry</span>
                <strong style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{success.journalEntryId}</strong>
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
          <a href="/wise" style={{ padding: '0.875rem 1.5rem', borderRadius: '12px', background: 'var(--surface-color)', border: '1px solid var(--surface-border)', color: 'var(--text-primary)', fontWeight: 600, textDecoration: 'none' }}>← Accounts</a>
          <button id="send-another-btn" className="btn-wise" onClick={() => { setSuccess(null); setStep(0); setQuote(null); setAmount(''); }}>Send Another</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '640px', margin: '0 auto' }}>
      <div className="wise-header-accent">💸 Wise · Payments</div>
      <h1 style={{ marginBottom: '2rem' }}>Make a Payment</h1>

      <Stepper step={step} />

      {/* Profile Selector (persistent) */}
      {profiles.length > 1 && (
        <div className="glass-card" style={{ marginBottom: '1.5rem', padding: '1rem 1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <label style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>Paying from</label>
            <select id="wise-profile-select" className="wise-form-select" style={{ margin: 0 }} value={profileId ?? ''} onChange={e => setProfileId(Number(e.target.value))}>
              {profiles.map(p => <option key={p.id} value={p.id}>{profileLabel(p)}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* ── STEP 0: Amount & Currency ── */}
      {step === 0 && (
        <div className="glass-card">
          <h2 style={{ marginBottom: '1.5rem' }}>Amount &amp; Currency</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div className="wise-form-group" style={{ marginBottom: 0 }}>
              <label className="wise-form-label">You send</label>
              <select id="src-currency" className="wise-form-select" value={srcCurrency} onChange={e => { setSrcCurrency(e.target.value); setQuote(null); }}>
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="wise-form-group" style={{ marginBottom: 0 }}>
              <label className="wise-form-label">Recipient gets</label>
              <select id="tgt-currency" className="wise-form-select" value={tgtCurrency} onChange={e => { setTgtCurrency(e.target.value); setQuote(null); }}>
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div className="wise-form-group" style={{ marginTop: '1rem' }}>
            <label className="wise-form-label">Amount ({srcCurrency})</label>
            <input id="payment-amount" className="wise-form-input" type="number" min="1" placeholder="0.00" value={amount} onChange={e => { setAmount(e.target.value); setQuote(null); }} />
          </div>

          {quoteError && <p style={{ color: 'var(--danger-color)', fontSize: '0.8rem', marginBottom: '0.75rem' }}>{quoteError}</p>}

          {quote && (
            <div className="wise-quote-card">
              <div className="wise-quote-row"><span className="wise-quote-label">Exchange Rate</span><span className="wise-quote-value">1 {srcCurrency} = {quote.rate.toFixed(4)} {tgtCurrency}</span></div>
              <div className="wise-quote-row"><span className="wise-quote-label">Wise Fee</span><span className="wise-quote-value">{quote.fee.toFixed(2)} {srcCurrency}</span></div>
              <div className="wise-quote-row"><span className="wise-quote-label">Recipient Gets</span><span className="wise-quote-value highlight">{quote.targetAmount.toFixed(2)} {tgtCurrency}</span></div>
              <div className="wise-quote-row"><span className="wise-quote-label">Estimated Arrival</span><span className="wise-quote-value">{new Date(quote.estimatedDelivery).toLocaleDateString('en-IE')}</span></div>
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.5rem', justifyContent: 'flex-end' }}>
            {!quote ? (
              <button id="get-quote-btn" className="btn-wise" onClick={fetchQuote} disabled={quoteLoading || !amount}>
                {quoteLoading ? 'Getting quote…' : 'Get Quote'}
              </button>
            ) : (
              <button id="next-to-recipient-btn" className="btn-wise" onClick={() => setStep(1)}>Next: Recipient →</button>
            )}
          </div>
        </div>
      )}

      {/* ── STEP 1: Recipient ── */}
      {step === 1 && (
        <div className="glass-card">
          <h2 style={{ marginBottom: '1.5rem' }}>Recipient Details</h2>

          <div className="wise-form-group">
            <label className="wise-form-label">Account Type</label>
            <select id="recipient-type" className="wise-form-select" value={recipientType} onChange={e => setRecipientType(e.target.value)}>
              <option value="iban">IBAN (Europe)</option>
              <option value="sort_code">Sort Code (UK)</option>
            </select>
          </div>

          <div className="wise-form-group">
            <label className="wise-form-label">Account Holder Name</label>
            <input id="recipient-name" className="wise-form-input" placeholder="Full legal name" value={recipientName} onChange={e => setRecipientName(e.target.value)} />
          </div>

          {recipientType === 'iban' ? (
            <div className="wise-form-group">
              <label className="wise-form-label">IBAN</label>
              <input id="recipient-iban" className="wise-form-input" placeholder="DE89 3704 0044 0532 0130 00" value={iban} onChange={e => setIban(e.target.value.replace(/\s/g, ''))} />
            </div>
          ) : (
            <>
              <div className="wise-form-group">
                <label className="wise-form-label">Sort Code</label>
                <input id="recipient-sort-code" className="wise-form-input" placeholder="20-00-00" value={sortCode} onChange={e => setSortCode(e.target.value)} />
              </div>
              <div className="wise-form-group">
                <label className="wise-form-label">Account Number</label>
                <input id="recipient-account-number" className="wise-form-input" placeholder="12345678" value={accountNumber} onChange={e => setAccountNumber(e.target.value)} />
              </div>
            </>
          )}

          {error && <p style={{ color: 'var(--danger-color)', fontSize: '0.8rem', marginBottom: '0.75rem' }}>{error}</p>}

          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'space-between', marginTop: '1.5rem' }}>
            <button id="back-to-amount-btn" onClick={() => setStep(0)} style={{ padding: '0.875rem 1.25rem', borderRadius: '12px', background: 'var(--surface-color)', border: '1px solid var(--surface-border)', color: 'var(--text-primary)', fontWeight: 600, cursor: 'pointer' }}>← Back</button>
            <button id="next-to-review-btn" className="btn-wise" onClick={handleRecipient} disabled={busy || !recipientName || (!iban && !sortCode)}>
              {busy ? 'Saving…' : 'Next: Review →'}
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 2: Review ── */}
      {step === 2 && quote && (
        <div className="glass-card">
          <h2 style={{ marginBottom: '1.5rem' }}>Review Payment</h2>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem', marginBottom: '1.5rem' }}>
            {[
              ['You send', `${amount} ${srcCurrency}`],
              ['Recipient gets', `${quote.targetAmount.toFixed(2)} ${tgtCurrency}`],
              ['Wise fee', `${quote.fee.toFixed(2)} ${srcCurrency}`],
              ['Rate', `1 ${srcCurrency} = ${quote.rate.toFixed(4)} ${tgtCurrency}`],
              ['Estimated arrival', new Date(quote.estimatedDelivery).toLocaleDateString('en-IE')],
              ['Recipient', recipientName],
            ].map(([label, value]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.625rem 0', borderBottom: '1px solid var(--surface-border)' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>

          <div className="wise-form-group">
            <label className="wise-form-label">Reference (optional)</label>
            <input id="payment-reference" className="wise-form-input" placeholder="e.g. Invoice #1042" value={reference} onChange={e => setReference(e.target.value)} />
          </div>

          {/* Journal Entry Section */}
          <div style={{ borderTop: '1px solid var(--surface-border)', paddingTop: '1.25rem', marginTop: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
              <input
                id="auto-journal-toggle"
                type="checkbox"
                checked={autoJournal}
                onChange={e => setAutoJournal(e.target.checked)}
                style={{ width: '16px', height: '16px', accentColor: 'var(--wise-green)', cursor: 'pointer' }}
              />
              <label htmlFor="auto-journal-toggle" style={{ fontWeight: 600, fontSize: '0.875rem', cursor: 'pointer' }}>
                Auto-post journal entry
              </label>
            </div>

            {autoJournal ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div className="wise-form-group" style={{ marginBottom: 0 }}>
                  <label className="wise-form-label">Debit GL Account ID</label>
                  <input id="debit-account-id" className="wise-form-input" placeholder="Accounts Payable ID" value={debitAccountId} onChange={e => setDebitAccountId(e.target.value)} />
                </div>
                <div className="wise-form-group" style={{ marginBottom: 0 }}>
                  <label className="wise-form-label">Credit GL Account ID</label>
                  <input id="credit-account-id" className="wise-form-input" placeholder="Wise Bank Account ID" value={creditAccountId} onChange={e => setCreditAccountId(e.target.value)} />
                </div>
              </div>
            ) : (
              <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', padding: '0.75rem', background: 'var(--surface-color)', borderRadius: '8px' }}>
                ✏️ No journal entry will be posted automatically. You can create one manually via the <a href="/ledger" style={{ color: 'var(--wise-green)', textDecoration: 'none' }}>Ledger</a>.
              </p>
            )}
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'space-between', marginTop: '1.5rem' }}>
            <button id="back-to-recipient-btn" onClick={() => setStep(1)} style={{ padding: '0.875rem 1.25rem', borderRadius: '12px', background: 'var(--surface-color)', border: '1px solid var(--surface-border)', color: 'var(--text-primary)', fontWeight: 600, cursor: 'pointer' }}>← Back</button>
            <button id="next-to-confirm-btn" className="btn-wise" onClick={() => setStep(3)}>Confirm Details →</button>
          </div>
        </div>
      )}

      {/* ── STEP 3: Final Confirm ── */}
      {step === 3 && quote && (
        <div className="glass-card">
          <h2 style={{ marginBottom: '0.5rem' }}>Confirm &amp; Send</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
            Please review one final time before sending.
          </p>

          <div className="wise-quote-card" style={{ marginTop: 0, marginBottom: '1.5rem' }}>
            <div className="wise-quote-row"><span className="wise-quote-label">Sending</span><span className="wise-quote-value">{amount} {srcCurrency}</span></div>
            <div className="wise-quote-row"><span className="wise-quote-label">Recipient gets</span><span className="wise-quote-value highlight">{quote.targetAmount.toFixed(2)} {tgtCurrency}</span></div>
            <div className="wise-quote-row"><span className="wise-quote-label">To</span><span className="wise-quote-value" style={{ fontSize: '0.9rem' }}>{recipientName}</span></div>
            <div className="wise-quote-row"><span className="wise-quote-label">Profile</span><span className="wise-quote-value" style={{ fontSize: '0.875rem' }}>{profiles.find(p => p.id === profileId) ? profileLabel(profiles.find(p => p.id === profileId)!) : '—'}</span></div>
          </div>

          {/* 4-Eyes confirmation checkbox */}
          <div style={{ background: 'rgba(55,183,135,0.08)', border: '1px solid var(--wise-green-border)', borderRadius: '10px', padding: '1rem 1.25rem', marginBottom: '1.5rem', display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
            <input id="payment-confirm-checkbox" type="checkbox" style={{ marginTop: '2px', width: '16px', height: '16px', accentColor: 'var(--wise-green)', cursor: 'pointer', flexShrink: 0 }} onChange={e => (document.getElementById('send-payment-btn') as HTMLButtonElement | null)!.disabled = !e.target.checked} />
            <label htmlFor="payment-confirm-checkbox" style={{ fontSize: '0.875rem', lineHeight: 1.5, cursor: 'pointer' }}>
              I confirm this payment is correct. I understand this will move real funds from my Wise account. <strong>(4-Eyes approval)</strong>
            </label>
          </div>

          {error && <p style={{ color: 'var(--danger-color)', fontSize: '0.8rem', marginBottom: '0.75rem' }}>{error}</p>}

          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'space-between' }}>
            <button id="back-to-review-btn" onClick={() => setStep(2)} style={{ padding: '0.875rem 1.25rem', borderRadius: '12px', background: 'var(--surface-color)', border: '1px solid var(--surface-border)', color: 'var(--text-primary)', fontWeight: 600, cursor: 'pointer' }}>← Back</button>
            <button id="send-payment-btn" className="btn-wise" onClick={handleSend} disabled={busy}>
              {busy ? 'Sending…' : `Send ${amount} ${srcCurrency}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
