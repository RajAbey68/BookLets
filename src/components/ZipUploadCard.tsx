'use client';

import React, { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Client-side pre-check mirror of MAX_ZIP_UPLOAD_BYTES (src/lib/zip-ingest.ts,
 * 100 MB). Not imported: zip-ingest pulls in adm-zip/node:crypto, which do not
 * belong in the client bundle. The server remains the authority — this only
 * saves Raj from uploading 100 MB just to see a 413.
 */
const MAX_ZIP_UPLOAD_MB = 100;

/** The fields of ZipIngestReport (src/lib/zip-ingest.ts) this card renders. */
interface UploadReport {
  created: number;
  deduped: number;
  skipped: { name: string; reason: string }[];
  failures: { name: string; stage: string; error: string }[];
}

type UploadStatus = 'IDLE' | 'UPLOADING' | 'DONE' | 'ERROR';

/** How many skipped/failed file names to list before collapsing to a count. */
const DETAIL_LIST_CAP = 5;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * S11 — upload a receipts zip into the sandbox.
 *
 * Sends the archive EXACTLY as /api/ingest/zip expects for a non-multipart
 * request: the raw zip bytes as the request body with Content-Type
 * application/zip (the route buffers the body via arrayBuffer() behind its
 * byte-cap guard). All security guards, dedupe, and OCR run server-side; the
 * returned ZipIngestReport is translated to plain English here.
 */
export default function ZipUploadCard() {
  const [status, setStatus] = useState<UploadStatus>('IDLE');
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<UploadReport | null>(null);
  const [isDragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const upload = async (file: File) => {
    setError(null);
    setReport(null);

    if (!file.name.toLowerCase().endsWith('.zip')) {
      setStatus('ERROR');
      setError(`"${file.name}" is not a .zip file — export the receipts as a zip archive first.`);
      return;
    }
    if (file.size > MAX_ZIP_UPLOAD_MB * 1024 * 1024) {
      setStatus('ERROR');
      setError(`Zip too large (max ${MAX_ZIP_UPLOAD_MB} MB). Split the export and upload in parts.`);
      return;
    }

    setStatus('UPLOADING');
    try {
      const res = await fetch('/api/ingest/zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      });

      // Error bodies are JSON ({ error, code? }) when the route answered, but
      // a proxy/edge 413 may not be — parse defensively.
      let body: { report?: UploadReport; error?: string } = {};
      try {
        body = await res.json();
      } catch {
        /* non-JSON body — fall through to the status-based messages */
      }

      if (!res.ok) {
        setStatus('ERROR');
        if (res.status === 401) setError('Sign in to upload receipts.');
        else if (res.status === 403) setError("Your role can't upload receipts here.");
        else if (res.status === 413) setError(body.error ?? `Zip too large (max ${MAX_ZIP_UPLOAD_MB} MB).`);
        else setError(body.error ?? `Upload failed (HTTP ${res.status}). Try again shortly.`);
        return;
      }

      if (!body.report) {
        setStatus('ERROR');
        setError('Upload succeeded but the server returned no summary. Refresh and check the queue.');
        return;
      }
      setReport(body.report);
      setStatus('DONE');
      // Re-render the server-side pieces (consensus queue, staging summary).
      router.refresh();
    } catch (err) {
      setStatus('ERROR');
      setError(err instanceof Error ? err.message : 'Upload failed. Check your connection and try again.');
    } finally {
      // Allow re-selecting the same file after an error or a second upload.
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void upload(file);
  };

  const busy = status === 'UPLOADING';

  return (
    <div className="glass-card">
      <h3 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>Upload receipts zip</h3>

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
            ? 'Uploading and reading the receipts — this can take a minute for large exports…'
            : 'Drag a WhatsApp/receipts export (.zip) here, or pick a file. Every receipt lands in the sandbox as a draft — nothing touches the books until it is approved.'}
        </p>
        <label className="btn btn-primary" style={{ cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Uploading…' : 'Choose .zip file'}
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip"
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

      {status === 'DONE' && report && (
        <div role="status" style={{ fontSize: '0.8125rem' }}>
          <div style={{ fontWeight: 600, marginBottom: '0.375rem' }}>
            {report.created} draft {report.created === 1 ? 'entry' : 'entries'} created,{' '}
            {plural(report.deduped, 'duplicate')} skipped
            {report.skipped.length > 0 ? `, ${plural(report.skipped.length, 'file')} not ingested` : ''}
            {report.failures.length > 0 ? `, ${plural(report.failures.length, 'failure')}` : ''}.
          </div>
          {report.created > 0 && (
            <div style={{ color: 'var(--text-secondary)', marginBottom: '0.375rem' }}>
              The new drafts are in the consensus queue below, waiting for approval.
            </div>
          )}
          {report.skipped.slice(0, DETAIL_LIST_CAP).map((s) => (
            <div key={s.name} style={{ color: 'var(--text-secondary)' }}>
              Skipped {s.name}: {s.reason}
            </div>
          ))}
          {report.skipped.length > DETAIL_LIST_CAP && (
            <div style={{ color: 'var(--text-secondary)' }}>
              …and {report.skipped.length - DETAIL_LIST_CAP} more skipped files.
            </div>
          )}
          {report.failures.slice(0, DETAIL_LIST_CAP).map((f) => (
            <div key={f.name} style={{ color: 'var(--danger-color)' }}>
              Failed {f.name} ({f.stage}): {f.error}
            </div>
          ))}
          {report.failures.length > DETAIL_LIST_CAP && (
            <div style={{ color: 'var(--danger-color)' }}>
              …and {report.failures.length - DETAIL_LIST_CAP} more failures.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
