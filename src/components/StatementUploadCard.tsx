'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  summarizeStatementReport,
  type StatementReportSummary,
} from '@/lib/statement-report-summary';
import type { StatementIngestReport } from '@/lib/statement-ingest';

/**
 * Client-side pre-check mirror of MAX_STATEMENT_UPLOAD_BYTES
 * (src/lib/statement-ingest.ts, 5 MB). Not imported: statement-ingest pulls
 * node:crypto, which does not belong in the client bundle. The server remains
 * the authority — this only saves Raj from uploading just to see a 413.
 */
const MAX_STATEMENT_UPLOAD_MB = 5;

/**
 * Client-side deadline for the whole import.
 *
 * Sits deliberately ABOVE the route's own `maxDuration` of 60s so that when
 * the server can answer — including when it fails — its specific message wins
 * over this generic one. This exists for the case where no answer comes at
 * all: before it, a killed function left the button reading "Uploading…"
 * indefinitely, which is exactly the silent hang this card was reported for.
 */
const UPLOAD_TIMEOUT_MS = 75_000;

type UploadStatus = 'IDLE' | 'UPLOADING' | 'DONE' | 'ERROR';

const TONE_COLORS: Record<StatementReportSummary['tone'], string> = {
  success: 'var(--success-color)',
  warning: 'var(--warning-color)',
  error: 'var(--danger-color)',
};

const DETAIL_COLORS: Record<StatementReportSummary['details'][number]['tone'], string> = {
  info: 'var(--text-secondary)',
  warning: 'var(--warning-color)',
  error: 'var(--danger-color)',
};

/**
 * Upload a bank-statement CSV into the sandbox — the statement twin of
 * ZipUploadCard. Sends the file EXACTLY as /api/ingest/statement expects for
 * a multipart request (form field "file"). All parsing, dedup, fiscal-period
 * gating and the balance check run server-side; the returned
 * StatementIngestReport is translated to plain English by
 * summarizeStatementReport — this component is dumb rendering only.
 */
export default function StatementUploadCard() {
  const [status, setStatus] = useState<UploadStatus>('IDLE');
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<StatementReportSummary | null>(null);
  const [isDragOver, setDragOver] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // A visible clock, for the same reason the receipts card has one: a long
  // import and a dead one look identical without it.
  useEffect(() => {
    if (status !== 'UPLOADING') return;
    setElapsedMs(0);
    const startedAt = Date.now();
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [status]);

  const upload = async (file: File) => {
    setError(null);
    setSummary(null);

    if (!file.name.toLowerCase().endsWith('.csv')) {
      setStatus('ERROR');
      setError(`"${file.name}" is not a .csv file — download the statement as CSV from the bank first.`);
      return;
    }
    if (file.size > MAX_STATEMENT_UPLOAD_MB * 1024 * 1024) {
      setStatus('ERROR');
      setError(`Statement too large (max ${MAX_STATEMENT_UPLOAD_MB} MB). Export a shorter date range.`);
      return;
    }

    setStatus('UPLOADING');
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await fetch('/api/ingest/statement', {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });

      // Error bodies are JSON ({ error, code? }) when the route answered, but
      // a proxy/edge 413 may not be — parse defensively.
      let body: { report?: StatementIngestReport; error?: string } = {};
      try {
        body = await res.json();
      } catch {
        /* non-JSON body — fall through to the status-based messages */
      }

      if (!res.ok) {
        setStatus('ERROR');
        if (res.status === 401) setError('Sign in to import bank statements.');
        else if (res.status === 403) setError("Your role can't import bank statements — ask an owner.");
        else if (res.status === 413) setError(body.error ?? `Statement too large (max ${MAX_STATEMENT_UPLOAD_MB} MB).`);
        else setError(body.error ?? `Import failed (HTTP ${res.status}). Try again shortly.`);
        return;
      }

      if (!body.report) {
        setStatus('ERROR');
        setError('Import succeeded but the server returned no summary. Refresh and check the queue.');
        return;
      }
      setSummary(summarizeStatementReport(body.report));
      setStatus('DONE');
      // Re-render the server-side pieces (consensus queue, staging summary).
      router.refresh();
    } catch (err) {
      setStatus('ERROR');
      if (err instanceof DOMException && err.name === 'AbortError') {
        // Say what is true of a half-finished import rather than implying
        // nothing happened: rows are posted one at a time, so some may have
        // landed before the server stopped answering. Re-uploading is safe —
        // every row carries an idempotency key, so anything already imported
        // is skipped, never booked twice.
        setError(
          `The import did not finish within ${Math.round(UPLOAD_TIMEOUT_MS / 1000)}s and was stopped. ` +
            'Some rows may already be in your books. Upload the same file again — anything already ' +
            'imported is skipped automatically and nothing is double-counted.',
        );
      } else {
        setError(
          err instanceof Error ? err.message : 'Import failed. Check your connection and try again.',
        );
      }
    } finally {
      clearTimeout(deadline);
      // Allow re-selecting the same file after an error or a second upload.
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    // The file input is disabled while busy, but drops bypass it — ignore
    // them too, or a second drop races the in-flight upload's state.
    if (status === 'UPLOADING') return;
    const file = e.dataTransfer.files?.[0];
    if (file) void upload(file);
  };

  const busy = status === 'UPLOADING';

  return (
    <div className="glass-card">
      <h3 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>Upload bank statement (CSV)</h3>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        style={{
          border: `2px dashed ${isDragOver ? 'var(--accent-color)' : 'var(--surface-border)'}`,
          borderRadius: 'var(--border-radius)',
          padding: '2rem 1.5rem',
          textAlign: 'center',
          marginBottom: '1rem',
        }}
      >
        <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', margin: '0 0 1rem' }}>
          {busy
            ? `Uploading and reading the statement… ${Math.floor(elapsedMs / 1000)}s elapsed. ` +
              'Each transaction is written separately, so a few hundred rows take a moment.'
            : 'Drag a bank-statement export (.csv) here, or pick a file. Wise exports are recognised automatically; every transaction lands as a draft and re-uploads never double-count.'}
        </p>
        <label className="btn btn-primary" style={{ cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Uploading…' : 'Choose .csv file'}
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </label>
      </div>

      {status === 'ERROR' && error && (
        <div role="alert" style={{ fontSize: '0.8125rem', color: 'var(--danger-color)', fontWeight: 600 }}>
          {error}
        </div>
      )}

      {status === 'DONE' && summary && (
        <div role="status" style={{ fontSize: '0.8125rem' }}>
          <div style={{ fontWeight: 600, marginBottom: '0.375rem', color: TONE_COLORS[summary.tone] }}>
            {summary.headline}
          </div>
          {summary.tone === 'success' && (
            <div style={{ color: 'var(--text-secondary)', marginBottom: '0.375rem' }}>
              The new drafts are in the consensus queue below, waiting for approval.
            </div>
          )}
          {summary.details.map((detail, index) => (
            <div key={index} style={{ color: DETAIL_COLORS[detail.tone], marginBottom: '0.25rem' }}>
              {detail.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
