'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  createFiscalPeriodAction,
  closeFiscalPeriodAction,
  type FiscalPeriodRow,
  type FiscalPeriodsView,
} from '@/app/actions/fiscal-period.actions';

/**
 * Accounting periods, for someone who does not know what one is.
 *
 * Three jobs, in the order they matter:
 *   1. When nothing is open, say so at the top in terms of consequence ("no
 *      receipt can be imported") and offer ONE button that fixes it — the
 *      current calendar year, pre-filled and named, not a blank form.
 *   2. Show what exists, with a status word a person understands: Open,
 *      Closed, Locked.
 *   3. Let a finished period be closed, with the consequence spelled out
 *      before the click, because there is no undo in this application.
 *
 * All the rules live server-side (fiscal-period.actions.ts). Nothing here is
 * trusted: the organisation, the role check and the overlap check all happen
 * again on the server.
 */

const fieldStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.75rem',
  borderRadius: '10px',
  background: 'var(--surface-color)',
  border: '1px solid var(--surface-border)',
  color: 'var(--text-primary)',
  fontSize: '0.9375rem',
  outline: 'none',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.75rem',
  color: 'var(--text-secondary)',
  marginBottom: '0.5rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const STATUS_COPY: Record<FiscalPeriodRow['status'], { label: string; note: string }> = {
  OPEN: { label: 'Open', note: 'You can record entries dated in this period.' },
  CLOSED: { label: 'Closed', note: 'Finished — nothing new can be dated in this period.' },
  LOCKED: { label: 'Locked', note: 'Held by your accountant — nothing new can be dated in it.' },
};

const formatDay = (date: Date) =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(date));

export default function FiscalPeriodManager({ view }: { view: FiscalPeriodsView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState(view.suggestion);
  const [confirmingClose, setConfirmingClose] = useState<string | null>(null);

  const run = (work: () => Promise<{ success: true; message: string } | { success: false; error: string }>) => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await work();
      if (result.success) {
        setNotice(result.message);
        setConfirmingClose(null);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  if (view.unavailable) {
    return (
      <div className="glass-card" style={{ padding: '2rem', color: 'var(--warning-color)' }}>
        Your accounting periods could not be read just now. This is a fault, not an empty list —
        do not create a period until this page loads properly, or you may end up with two.
        Refresh to retry.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* ── The blocker banner: consequence first, one-click fix ── */}
      {!view.coversToday && (
        <div
          className="glass-card"
          style={{ borderLeft: '4px solid var(--warning-color)', padding: '1.25rem 1.5rem' }}
        >
          <h2 style={{ fontSize: '1.0625rem', margin: '0 0 0.5rem' }}>
            No period is open for today — nothing can be recorded yet
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9375rem', margin: '0 0 1rem', maxWidth: '48rem' }}>
            Every receipt you import is refused until a period covers its date. Opening{' '}
            <strong>{view.suggestion.name}</strong> ({view.suggestion.startDate} to{' '}
            {view.suggestion.endDate}) covers this whole year, which is what most people want.
            You can close it when the year is done.
          </p>
          {view.canManage ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending}
              onClick={() => run(() => createFiscalPeriodAction(view.suggestion))}
            >
              {pending ? 'Opening…' : `Open ${view.suggestion.name}`}
            </button>
          ) : (
            <p style={{ fontSize: '0.875rem', margin: 0, color: 'var(--text-secondary)' }}>
              Ask an owner or your accountant to open a period.
            </p>
          )}
        </div>
      )}

      {notice && (
        <div className="glass-card" style={{ padding: '1rem 1.25rem', fontSize: '0.9375rem' }}>
          {notice}
        </div>
      )}
      {error && (
        <div
          className="glass-card"
          style={{ padding: '1rem 1.25rem', fontSize: '0.9375rem', color: 'var(--warning-color)' }}
          role="alert"
        >
          {error}
        </div>
      )}

      {/* ── What exists ── */}
      <div className="glass-card">
        <h2 style={{ fontSize: '1rem', margin: '0 0 1rem' }}>Your periods</h2>
        {view.periods.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9375rem', margin: 0 }}>
            You have no periods yet. Open one above (or below) and your receipts will start
            importing.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9375rem' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-secondary)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  <th style={{ padding: '0.5rem 0.75rem 0.5rem 0' }}>Period</th>
                  <th style={{ padding: '0.5rem 0.75rem' }}>Covers</th>
                  <th style={{ padding: '0.5rem 0.75rem' }}>Status</th>
                  <th style={{ padding: '0.5rem 0 0.5rem 0.75rem' }} />
                </tr>
              </thead>
              <tbody>
                {view.periods.map((period) => (
                  <tr key={period.id} style={{ borderTop: '1px solid var(--surface-border)' }}>
                    <td style={{ padding: '0.75rem 0.75rem 0.75rem 0', fontWeight: 600 }}>
                      {period.name}
                    </td>
                    <td style={{ padding: '0.75rem', color: 'var(--text-secondary)' }}>
                      {formatDay(period.startDate)} – {formatDay(period.endDate)}
                    </td>
                    <td style={{ padding: '0.75rem' }}>
                      <div>{STATUS_COPY[period.status].label}</div>
                      <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                        {STATUS_COPY[period.status].note}
                      </div>
                    </td>
                    <td style={{ padding: '0.75rem 0 0.75rem 0.75rem', textAlign: 'right' }}>
                      {period.status === 'OPEN' && view.canManage && (
                        confirmingClose === period.id ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'flex-end' }}>
                            <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', maxWidth: '22rem', textAlign: 'right' }}>
                              Closing <strong>{period.name}</strong> fixes its figures. Nothing new
                              can ever be dated inside it, and this cannot be undone here.
                            </span>
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                              <button
                                type="button"
                                className="btn"
                                disabled={pending}
                                onClick={() => setConfirmingClose(null)}
                              >
                                Keep it open
                              </button>
                              <button
                                type="button"
                                className="btn btn-primary"
                                disabled={pending}
                                onClick={() => run(() => closeFiscalPeriodAction({ id: period.id }))}
                              >
                                {pending ? 'Closing…' : 'Close it'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="btn"
                            disabled={pending}
                            onClick={() => setConfirmingClose(period.id)}
                          >
                            Close period
                          </button>
                        )
                      )}
                      {period.status === 'CLOSED' && period.closedAt && (
                        <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                          Closed {formatDay(period.closedAt)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Open another one ── */}
      {view.canManage && (
        <form
          className="glass-card"
          style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: '40rem' }}
          onSubmit={(event) => {
            event.preventDefault();
            run(() => createFiscalPeriodAction(form));
          }}
        >
          <div>
            <h2 style={{ fontSize: '1rem', margin: '0 0 0.375rem' }}>Open another period</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', margin: 0 }}>
              Periods must not overlap, so each date belongs to exactly one of them. Most books
              use one period per year; a monthly period is fine too if you close your months.
            </p>
          </div>

          <div>
            <label style={labelStyle} htmlFor="period-name">
              Name it
            </label>
            <input
              id="period-name"
              name="name"
              style={fieldStyle}
              value={form.name}
              placeholder="FY 2026"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))', gap: '1rem' }}>
            <div>
              <label style={labelStyle} htmlFor="period-start">
                First day it covers
              </label>
              <input
                id="period-start"
                name="startDate"
                type="date"
                style={fieldStyle}
                value={form.startDate}
                onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                required
              />
            </div>
            <div>
              <label style={labelStyle} htmlFor="period-end">
                Last day it covers
              </label>
              <input
                id="period-end"
                name="endDate"
                type="date"
                style={fieldStyle}
                value={form.endDate}
                onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                required
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            <button type="submit" className="btn btn-primary" disabled={pending}>
              {pending ? 'Opening…' : 'Open this period'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={pending}
              onClick={() => setForm(view.suggestion)}
            >
              Use this year
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
