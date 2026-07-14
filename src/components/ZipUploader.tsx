'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { summarizeZipIngestReport, type ZipIngestSummary } from '@/lib/zip-ingest-summary';
import type { ZipIngestReport } from '@/lib/zip-ingest';

type UploaderStatus = 'IDLE' | 'UPLOADING' | 'DONE' | 'ERROR';

const IconUpload = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ width: '20px', height: '20px' }}>
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
  </svg>
);

const TONE_STYLES: Record<ZipIngestSummary['tone'], { border: string; bg: string }> = {
  success: { border: 'rgba(34, 197, 94, 0.4)', bg: 'rgba(34, 197, 94, 0.08)' },
  neutral: { border: 'var(--surface-border)', bg: 'rgba(255,255,255,0.02)' },
  warning: { border: 'rgba(234, 179, 8, 0.4)', bg: 'rgba(234, 179, 8, 0.08)' },
  error: { border: 'rgba(244, 63, 94, 0.4)', bg: 'rgba(244, 63, 94, 0.08)' },
};

/**
 * S5 follow-up — front door for POST /api/ingest/zip. The endpoint and its
 * security guards (path traversal, zip-bomb ratio, size caps, idempotency)
 * already existed with zero UI callers; this component is that missing
 * front door. Every entry it creates lands as DRAFT (server-enforced) —
 * nothing here can post to the ledger directly.
 */
export default function ZipUploader() {
  const [status, setStatus] = useState<UploaderStatus>('IDLE');
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ZipIngestSummary | null>(null);
  const router = useRouter();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file after a retry
    if (!file) return;

    setStatus('UPLOADING');
    setError(null);
    setSummary(null);

    try {
      const form = new FormData();
      form.set('file', file);

      const response = await fetch('/api/ingest/zip', {
        method: 'POST',
        body: form,
      });

      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(body.error || `Upload failed (HTTP ${response.status}).`);
      }

      const report = body.report as ZipIngestReport;
      setSummary(summarizeZipIngestReport(report));
      setStatus('DONE');
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Zip upload failed.';
      console.error('[ZipUploader]', err);
      setError(message);
      setStatus('ERROR');
    }
  };

  const toneStyle = summary ? TONE_STYLES[summary.tone] : null;

  return (
    <div className="glass-card" style={{ marginBottom: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: '0.9375rem' }}>Import WhatsApp export</h3>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
            Upload a chat export zip (receipt photos + chat text). Every receipt becomes a DRAFT
            entry below for 4-eyes review — nothing posts automatically.
          </p>
        </div>

        <label
          className="btn btn-primary"
          style={{ cursor: status === 'UPLOADING' ? 'not-allowed' : 'pointer', opacity: status === 'UPLOADING' ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: '0.5rem', whiteSpace: 'nowrap' }}
        >
          <IconUpload />
          {status === 'UPLOADING' ? 'Uploading…' : 'Upload zip'}
          <input
            type="file"
            accept=".zip,application/zip"
            style={{ display: 'none' }}
            disabled={status === 'UPLOADING'}
            onChange={handleFileChange}
          />
        </label>
      </div>

      {status === 'ERROR' && error && (
        <div role="alert" style={{ marginTop: '1rem', fontSize: '0.8125rem', color: 'var(--danger-color)' }}>
          {error}
        </div>
      )}

      {summary && toneStyle && (
        <div
          role="status"
          style={{
            marginTop: '1rem',
            padding: '0.875rem 1rem',
            borderRadius: '10px',
            border: `1px solid ${toneStyle.border}`,
            background: toneStyle.bg,
          }}
        >
          <div style={{ fontSize: '0.875rem', fontWeight: 600 }}>{summary.headline}</div>
          {summary.details.length > 0 && (
            <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
              {summary.details.map((detail, i) => (
                <li key={i}>{detail}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
