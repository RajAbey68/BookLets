'use client';
import { useState, useEffect, useCallback } from 'react';
import { getWiseAccounts, getWiseTransfers, createWiseAccount } from '../actions/wise.actions';
import type { WiseBalance, WiseTransferResult } from '@/lib/wise.service';

const FLAGS: Record<string, string> = { EUR:'🇪🇺',USD:'🇺🇸',GBP:'🇬🇧',CHF:'🇨🇭',JPY:'🇯🇵',AUD:'🇦🇺',CAD:'🇨🇦',NZD:'🇳🇿',HKD:'🇭🇰',SGD:'🇸🇬',NOK:'🇳🇴',SEK:'🇸🇪',DKK:'🇩🇰',PLN:'🇵🇱',CZK:'🇨🇿',HUF:'🇭🇺',BRL:'🇧🇷',INR:'🇮🇳',ZAR:'🇿🇦',AED:'🇦🇪',THB:'🇹🇭',MXN:'🇲🇽' };
const POPULAR = ['EUR','USD','GBP','CHF','AUD','CAD','JPY','SGD','HKD','NZD','NOK','SEK','DKK','PLN'];

function flag(c: string) { return FLAGS[c] ?? '🏦'; }
function fmt(v: number, c: string) { return new Intl.NumberFormat('en-IE', { style: 'currency', currency: c, minimumFractionDigits: 2 }).format(v); }
function statusClass(s: string) {
  const l = s?.toLowerCase() ?? '';
  if (l.includes('sent') || l === 'outgoing_payment_sent') return 'badge badge-transfer-completed';
  if (l.includes('cancel')) return 'badge badge-transfer-cancelled';
  if (l.includes('fail')) return 'badge badge-transfer-failed';
  if (l.includes('process') || l.includes('convert')) return 'badge badge-transfer-processing';
  return 'badge badge-transfer-pending';
}

function CreateModal({ onClose, onCreate }: { onClose: () => void; onCreate: (c: string) => Promise<void> }) {
  const [cur, setCur] = useState('');
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const eff = cur === '__custom__' ? custom.toUpperCase() : cur;

  const submit = async () => {
    if (!eff || eff.length !== 3) { setErr('Enter a valid 3-letter code.'); return; }
    setBusy(true); setErr('');
    try { await onCreate(eff); onClose(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="wise-modal-overlay" onClick={onClose}>
      <div className="wise-modal" onClick={e => e.stopPropagation()}>
        <h2 style={{ marginBottom: '0.25rem' }}>Create Currency Account</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>Add a new Wise balance in any supported currency.</p>
        <div className="wise-form-group">
          <label className="wise-form-label">Currency</label>
          <select id="create-account-currency" className="wise-form-select" value={cur} onChange={e => setCur(e.target.value)}>
            <option value="">— Select —</option>
            {POPULAR.map(c => <option key={c} value={c}>{flag(c)} {c}</option>)}
            <option value="__custom__">✏️ Other</option>
          </select>
        </div>
        {cur === '__custom__' && (
          <div className="wise-form-group">
            <label className="wise-form-label">Code (3 letters)</label>
            <input id="create-account-custom" className="wise-form-input" maxLength={3} placeholder="e.g. BRL" value={custom} onChange={e => setCustom(e.target.value.toUpperCase())} />
          </div>
        )}
        {err && <p style={{ color: 'var(--danger-color)', fontSize: '0.8rem', marginBottom: '1rem' }}>{err}</p>}
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
          <button id="modal-cancel-btn" onClick={onClose} style={{ padding: '0.75rem 1.25rem', borderRadius: '10px', background: 'var(--surface-color)', border: '1px solid var(--surface-border)', color: 'var(--text-primary)', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button id="modal-submit-btn" className="btn-wise" onClick={submit} disabled={busy || !eff}>{busy ? 'Creating…' : `Create ${eff}`}</button>
        </div>
      </div>
    </div>
  );
}

export default function WisePage() {
  const [balances, setBalances] = useState<WiseBalance[]>([]);
  const [transfers, setTransfers] = useState<WiseTransferResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const [a, t] = await Promise.all([getWiseAccounts(), getWiseTransfers()]);
    if (a.success) setBalances(a.data); else setError(a.error);
    if (t.success) setTransfers(t.data.slice(0, 20));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (currency: string) => {
    const r = await createWiseAccount(currency);
    if (!r.success) throw new Error(r.error);
    setToast(`✅ ${currency} account created`);
    setTimeout(() => setToast(''), 4000);
    await load();
  };

  const eurTotal = balances.filter(b => b.currency === 'EUR').reduce((s, b) => s + (b.amount?.value ?? 0), 0);

  return (
    <>
      {toast && <div style={{ position: 'fixed', bottom: '2rem', right: '2rem', background: 'rgba(55,183,135,0.15)', border: '1px solid var(--wise-green)', borderRadius: '12px', padding: '1rem 1.5rem', color: 'var(--wise-green)', fontWeight: 600, zIndex: 300, animation: 'slideUp 0.2s ease' }}>{toast}</div>}
      {showModal && <CreateModal onClose={() => setShowModal(false)} onCreate={handleCreate} />}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '2.5rem' }}>
        <div>
          <div className="wise-header-accent">🏦 Wise · Banking</div>
          <h1 style={{ marginBottom: 0 }}>Currency Accounts</h1>
          {!loading && eurTotal > 0 && <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>EUR balance: <strong style={{ color: 'var(--wise-green)' }}>{fmt(eurTotal, 'EUR')}</strong></p>}
        </div>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button id="wise-refresh-btn" onClick={load} style={{ padding: '0.75rem 1.25rem', borderRadius: '10px', background: 'var(--surface-color)', border: '1px solid var(--surface-border)', color: 'var(--text-secondary)', fontWeight: 600, cursor: 'pointer', fontSize: '0.875rem' }}>↻ Refresh</button>
          <button id="wise-new-account-btn" className="btn-wise" onClick={() => setShowModal(true)}>+ New Account</button>
        </div>
      </div>

      {error && (
        <div className="glass-card" style={{ borderColor: 'var(--danger-color)', marginBottom: '2rem' }}>
          <p style={{ color: 'var(--danger-color)', fontWeight: 600 }}>⚠️ {error}</p>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: '0.5rem' }}>Ensure <code>WISE_API_TOKEN</code> is set in <code>.env.local</code>.</p>
        </div>
      )}

      {loading ? (
        <div className="wise-balances-grid">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="wise-currency-card" style={{ opacity: 0.4 }}>
              <div className="currency-flag">🏦</div>
              <div className="currency-code">···</div>
              <div className="currency-amount">—</div>
            </div>
          ))}
        </div>
      ) : balances.length > 0 ? (
        <div className="wise-balances-grid">
          {balances.map(b => (
            <div key={b.id} className="wise-currency-card">
              <div className="currency-flag">{flag(b.currency)}</div>
              <div className="currency-code">{b.currency} · {b.balanceType}</div>
              <div className="currency-amount">{fmt(b.amount?.value ?? 0, b.currency)}</div>
              <div className="currency-label">Available · Reserved: {fmt(b.reservedAmount?.value ?? 0, b.currency)}</div>
            </div>
          ))}
        </div>
      ) : !error && (
        <div className="glass-card" style={{ textAlign: 'center', padding: '3rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🏦</div>
          <h2 style={{ marginBottom: '0.5rem' }}>No currency accounts yet</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>Create your first Wise currency balance to start sending payments.</p>
          <button id="wise-create-first-btn" className="btn-wise" onClick={() => setShowModal(true)}>+ Create First Account</button>
        </div>
      )}

      {!loading && transfers.length > 0 && (
        <div className="glass-card" style={{ marginTop: '2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
            <h2 style={{ marginBottom: 0 }}>Recent Transfers</h2>
            <a href="/wise/payments" style={{ color: 'var(--wise-green)', fontSize: '0.875rem', fontWeight: 600, textDecoration: 'none' }}>+ New Payment →</a>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="premium-table" style={{ width: '100%' }}>
              <thead><tr><th>ID</th><th>From</th><th>To</th><th>Amount</th><th>Reference</th><th>Status</th><th>Date</th></tr></thead>
              <tbody>
                {transfers.map(tx => (
                  <tr key={tx.id}>
                    <td data-label="ID" style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>#{tx.id}</td>
                    <td data-label="From">{tx.sourceCurrency}</td>
                    <td data-label="To">{tx.targetCurrency}</td>
                    <td data-label="Amount" style={{ fontWeight: 700 }}>
                      {fmt(tx.sourceValue, tx.sourceCurrency)}
                      {tx.sourceCurrency !== tx.targetCurrency && <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginLeft: '0.4rem' }}>→ {fmt(tx.targetValue, tx.targetCurrency)}</span>}
                    </td>
                    <td data-label="Reference" style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>{tx.details?.reference ?? '—'}</td>
                    <td data-label="Status"><span className={statusClass(tx.status)}>{tx.status?.replace(/_/g, ' ')}</span></td>
                    <td data-label="Date" style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>{new Date(tx.created).toLocaleDateString('en-IE')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && transfers.length === 0 && !error && (
        <div className="glass-card" style={{ marginTop: '2rem', textAlign: 'center', padding: '2rem' }}>
          <p style={{ color: 'var(--text-secondary)' }}>No transfers yet. <a href="/wise/payments" style={{ color: 'var(--wise-green)', textDecoration: 'none', fontWeight: 600 }}>Make your first payment →</a></p>
        </div>
      )}
    </>
  );
}
