'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { preflightZipFile, summarizeZipUploadResponse } from '@/lib/zip-upload-result';
import { DIRECT_UPLOAD_TIMEOUT_MS, MAX_DIRECT_UPLOAD_MB, describeElapsed } from '@/lib/upload-limits';

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
 *
 * Size, type and error copy all come from the shared modules (upload-limits /
 * zip-upload-result) so this card and the dashboard's WhatsappZipUploader can
 * never again disagree about what the platform will accept.
 */
export default function ZipUploadCard() {
  const [status, setStatus] = useState<UploadStatus>('IDLE');
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<UploadReport | null>(null);
  const [isDragOver, setDragOver] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Visible proof of life while UPLOADING — a static "Uploading…" label cannot
  // distinguish a slow import from a dead request.
  // No synchronous tick here: the trigger site already sets elapsedMs to 0
  // alongside startedAt, and setState in an effect body cascades an extra
  // render (react-hooks/set-state-in-effect). The first interval tick lands a
  // second later, which is exactly what a 0-second reading would have shown.
  useEffect(() => {
    if (status !== 'UPLOADING' || startedAt === null) return;
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [status, startedAt]);

  const upload = async (file: File) => {
    setError(null);
    setReport(null);

    // Shared preflight: wrong type, empty, or over the platform's request-body
    // ceiling. An oversized body is killed at the edge before our route runs,
    // so this is the only chance to say anything truthful about it.
    const preflight = preflightZipFile(file.name, file.size);
    if (preflight) {
      setStatus('ERROR');
      setError(`${preflight.title} — ${preflight.message}`);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }

    setStatus('UPLOADING');
    setStartedAt(Date.now());
    setElapsedMs(0);

    // This card previously had NO timeout: a stalled connection left it on
    // "Uploading…" forever. Aborting the signal tears the request down at any
    // stage, so ERROR is always reachable.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DIRECT_UPLOAD_TIMEOUT_MS);
    try {
      const res = await fetch('/api/ingest/zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
        signal: controller.signal,
      });

      // Error bodies are JSON ({ error, code? }) when the route answered, but a
      // platform-edge 413 is PLAIN TEXT and res.json() throws — and it can also
      // resolve to a non-object (null), so never assume a shape.
      let body: unknown = {};
      try {
        body = await res.json();
      } catch {
        /* non-JSON body — the summarizer stands on the status code alone */
      }

      if (!res.ok) {
        const summary = summarizeZipUploadResponse(res.status, body);
        setStatus('ERROR');
        setError(`${summary.title} — ${summary.message}`);
        return;
      }

      const parsedReport =
        body && typeof body === 'object' && 'report' in body
          ? ((body as { report?: UploadReport }).report ?? null)
          : null;
      if (!parsedReport) {
        setStatus('ERROR');
        setError('Upload succeeded but the server returned no summary. Refresh and check the queue.');
        return;
      }
      setReport(parsedReport);
      setStatus('DONE');
      // Re-render the server-side pieces (consensus queue, staging summary).
      router.refresh();
    } catch (err) {
      setStatus('ERROR');
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError(
          `The server did not answer within ${Math.round(DIRECT_UPLOAD_TIMEOUT_MS / 60000)} minutes, so the ` +
            'upload was cancelled rather than left hanging. Try again — already-imported receipts are skipped.',
        );
      } else {
        setError(err instanceof Error ? err.message : 'Upload failed. Check your connection and try again.');
      }
    } finally {
      clearTimeout(timeout);
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
            ? `Uploading and reading the receipts — still working, ${describeElapsed(elapsedMs)}.`
            : `Drag a WhatsApp/receipts export (.zip) here, or pick a file — up to ${MAX_DIRECT_UPLOAD_MB} MB (a hosting-platform limit). Every receipt lands in the sandbox as a draft — nothing touches the books until it is approved.`}
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
