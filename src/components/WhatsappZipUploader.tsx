'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import {
  summarizeZipUploadResponse,
  preflightZipFile,
  type ZipUploadResult,
} from '../lib/zip-upload-result';

/** Hard cap so a stuck request never leaves the UI on "Importing…" forever. */
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Uploads a WhatsApp finance/petty-cash export (.zip of _chat.txt + receipt
 * images) to POST /api/ingest/zip. The endpoint creates DRAFT journal entries
 * only — nothing posts to the ledger until it is approved in the review queue.
 * Result mapping lives in the pure `summarizeZipUploadResponse` (unit-tested).
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
  message: 'The import took too long and was cancelled. Try a smaller export or check your connection.',
  ...EMPTY_COUNTS,
};

export const WhatsappZipUploader: React.FC = () => {
  const [status, setStatus] = useState<UploaderStatus>('IDLE');
  const [result, setResult] = useState<ZipUploadResult | null>(null);

  const cardClass = [
    'glass-card',
    status === 'UPLOADING' ? 'is-analyzing' : '',
    status === 'DONE' ? 'is-success' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const reset = () => {
    setStatus('IDLE');
    setResult(null);
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/ingest/zip', {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });

      let body: unknown = {};
      try {
        body = await res.json();
      } catch {
        // non-JSON body (e.g. gateway error page) — summarizer falls back on status
      }

      const summary = summarizeZipUploadResponse(res.status, body);
      setResult(summary);
      setStatus(summary.ok ? 'DONE' : 'ERROR');
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
        <div className={`uploader-icon ${status === 'UPLOADING' ? 'pulsing' : ''}`}>
          {status === 'DONE' ? <IconCheck /> : status === 'ERROR' ? <IconAlert /> : <IconArchive />}
        </div>

        <h3 className="uploader-title">
          {status === 'IDLE' && 'Import WhatsApp export'}
          {status === 'UPLOADING' && 'Importing…'}
          {(status === 'DONE' || status === 'ERROR') && result?.title}
        </h3>

        <p className="uploader-body">
          {status === 'IDLE' &&
            'Upload a WhatsApp chat export (.zip). Receipt images and messages become DRAFT entries for you to review — nothing posts automatically.'}
          {status === 'UPLOADING' && 'Reading the archive and extracting receipts…'}
          {(status === 'DONE' || status === 'ERROR') && result?.message}
        </p>

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

      {status === 'UPLOADING' && (
        <div className="uploader-progress">
          <div className="uploader-progress-bar" />
        </div>
      )}
    </div>
  );
};
