'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  summarizeZipUploadResponse,
  preflightZipFile,
  describeProgress,
  splitNdjson,
  MAX_ZIP_IMAGES,
  type ZipUploadResult,
  type ZipProgress,
} from '../lib/zip-upload-result';
import {
  DIRECT_UPLOAD_TIMEOUT_MS,
  MAX_DIRECT_UPLOAD_MB,
  describeElapsed,
} from '../lib/upload-limits';

/**
 * Uploads a WhatsApp finance/petty-cash export (.zip of _chat.txt + receipt
 * images) to POST /api/ingest/zip. The endpoint STREAMS NDJSON progress — one
 * event per image — so this shows a live number-by-number count (never a
 * spinner: a spinner can't tell a slow import from a stuck one). Every entry is
 * DRAFT; nothing posts to the ledger until approved in the review queue.
 */

type UploaderStatus = 'IDLE' | 'UPLOADING' | 'DONE' | 'ERROR';

const IconArchive = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v1a2 2 0 01-2 2M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
  </svg>
);

const IconCheck = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
  </svg>
);

const IconAlert = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
  </svg>
);

const EMPTY_COUNTS = { created: 0, deduped: 0, skipped: 0, failed: 0, showReviewLink: false };

const NETWORK_ERROR: ZipUploadResult = {
  ok: false,
  title: 'Upload failed',
  message: 'Could not reach the server. Check your connection and try again.',
  ...EMPTY_COUNTS,
};

const TIMEOUT_ERROR: ZipUploadResult = {
  ok: false,
  title: 'Upload timed out',
  message:
    `The server did not answer within ${Math.round(DIRECT_UPLOAD_TIMEOUT_MS / 60000)} minutes, so the import was ` +
    'cancelled rather than left hanging. Re-upload the same export — already-imported receipts are skipped.',
  ...EMPTY_COUNTS,
};

function interruptedResult(last: ZipProgress | null): ZipUploadResult {
  const where = last ? ` at ${last.done} of ${last.total}` : '';
  return {
    ok: false,
    title: 'Import interrupted',
    message: `The import stopped early${where}. Re-upload the same export to resume — already-imported receipts are skipped.`,
    ...EMPTY_COUNTS,
  };
}

export const WhatsappZipUploader: React.FC = () => {
  const [status, setStatus] = useState<UploaderStatus>('IDLE');
  const [result, setResult] = useState<ZipUploadResult | null>(null);
  const [progress, setProgress] = useState<ZipProgress | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  // A number that visibly moves is the only way to tell a slow import from a
  // dead one. The original bug looked exactly like "working" for hours.
  // No synchronous tick here: the trigger site already sets elapsedMs to 0
  // alongside startedAt, and setState in an effect body cascades an extra
  // render (react-hooks/set-state-in-effect). The first interval tick lands a
  // second later, which is exactly what a 0-second reading would have shown.
  useEffect(() => {
    if (status !== 'UPLOADING' || startedAt === null) return;
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [status, startedAt]);

  const cardClass = ['glass-card', status === 'DONE' ? 'is-success' : ''].filter(Boolean).join(' ');

  const reset = () => {
    setStatus('IDLE');
    setResult(null);
    setProgress(null);
    setStartedAt(null);
    setElapsedMs(0);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Clear the input so re-selecting the same file fires change again.
    e.target.value = '';
    if (!file) return;

    // Reject wrong-type / empty / oversized files before spending a round-trip.
    const preflight = preflightZipFile(file.name, file.size);
    if (preflight) {
      setResult(preflight);
      setStatus('ERROR');
      return;
    }

    setStatus('UPLOADING');
    setResult(null);
    setProgress(null);
    setStartedAt(Date.now());
    setElapsedMs(0);

    // Aborting the signal tears down the request at ANY stage — while the body
    // is still being uploaded, while waiting for headers, and while the NDJSON
    // reader is blocked on read(). That is what makes an indefinite hang
    // impossible rather than merely unlikely.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DIRECT_UPLOAD_TIMEOUT_MS);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/ingest/zip', {
        method: 'POST',
        body: form,
        headers: { accept: 'application/x-ndjson' },
        signal: controller.signal,
      });

      // Auth (401) / byte-cap (413) return a plain status, no stream. A 413
      // raised by the PLATFORM EDGE (body over ~4.5 MB) never reaches our
      // route at all and its body is plain text, so res.json() throws here —
      // the summarizer must, and does, stand on the status code alone.
      if (!res.ok || !res.body) {
        let body: unknown = {};
        try {
          body = await res.json();
        } catch {
          // non-JSON error page — summarizer falls back on the status code
        }
        const summary = summarizeZipUploadResponse(res.status, body);
        setResult(summary);
        setStatus(summary.ok ? 'DONE' : 'ERROR');
        return;
      }

      // NDJSON stream: progress ticks, then a terminal done/error event.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let last: ZipProgress | null = null;
      let settled = false;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = splitNdjson(buffer);
        buffer = rest;
        for (const raw of events) {
          const ev = raw as Record<string, unknown>;
          if (ev.type === 'progress') {
            last = ev as unknown as ZipProgress;
            setProgress(last);
          } else if (ev.type === 'done') {
            const summary = summarizeZipUploadResponse(200, { report: ev.report });
            setResult(summary);
            setStatus(summary.ok ? 'DONE' : 'ERROR');
            settled = true;
          } else if (ev.type === 'error') {
            const summary = summarizeZipUploadResponse(Number(ev.status) || 500, {
              error: ev.message,
              code: ev.code,
              meta: ev.meta,
            });
            setResult(summary);
            setStatus('ERROR');
            settled = true;
          }
        }
      }

      // Stream ended with no terminal event → the request was cut off mid-batch
      // (e.g. a serverless timeout). Show exactly how far it got.
      if (!settled) {
        setResult(interruptedResult(last));
        setStatus('ERROR');
      }
    } catch (err) {
      console.error('[WhatsappZipUploader]', err);
      setResult(err instanceof DOMException && err.name === 'AbortError' ? TIMEOUT_ERROR : NETWORK_ERROR);
      setStatus('ERROR');
    } finally {
      clearTimeout(timeout);
    }
  };

  return (
    <div className={cardClass}>
      <div className="uploader">
        <div className="uploader-icon">
          {status === 'DONE' ? <IconCheck /> : status === 'ERROR' ? <IconAlert /> : <IconArchive />}
        </div>

        <h3 className="uploader-title">
          {status === 'IDLE' && 'Import WhatsApp export'}
          {status === 'UPLOADING' && 'Importing…'}
          {(status === 'DONE' || status === 'ERROR') && result?.title}
        </h3>

        <p className="uploader-body" aria-live="polite">
          {status === 'IDLE' &&
            'Upload a WhatsApp chat export (.zip). Receipt images and messages become DRAFT entries for you to review — nothing posts automatically.'}
          {status === 'UPLOADING' &&
            (progress ? describeProgress(progress) : 'Reading the archive…')}
          {(status === 'DONE' || status === 'ERROR') && result?.message}
        </p>

        {status === 'UPLOADING' && (
          // Deliberately outside the aria-live region above: it ticks every
          // second and would otherwise spam a screen reader.
          <p
            className="uploader-elapsed"
            style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}
          >
            Still working — {describeElapsed(elapsedMs)}. This stops on its own after{' '}
            {Math.round(DIRECT_UPLOAD_TIMEOUT_MS / 60000)} minutes rather than waiting forever.
          </p>
        )}

        {status === 'IDLE' && (
          <>
            <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
              Import WhatsApp export (.zip)
              <input
                type="file"
                style={{ display: 'none' }}
                accept=".zip,application/zip,application/x-zip-compressed"
                onChange={handleFileChange}
              />
            </label>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.75rem' }}>
              In WhatsApp: open the chat → Export Chat → <strong>Attach Media</strong> → save the .zip.
              The file must be under <strong>{MAX_DIRECT_UPLOAD_MB} MB</strong> (a hosting-platform
              limit we cannot raise) and hold at most {MAX_ZIP_IMAGES} new receipts, so export
              short date ranges — 1–2 weeks at a time. Exporting <em>Without Media</em> keeps the
              file small but contains no receipt photos, so it creates no entries.
            </p>
          </>
        )}

        {status === 'DONE' && result?.showReviewLink && (
          <Link href="/review" className="btn btn-primary" style={{ marginTop: '0.5rem' }}>
            Review drafts
          </Link>
        )}

        {(status === 'DONE' || status === 'ERROR') && (
          <button
            type="button"
            onClick={reset}
            className="uploader-error-link"
            style={{ marginTop: '0.5rem' }}
          >
            Import another
          </button>
        )}
      </div>
    </div>
  );
};
