'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import {
  summarizeZipUploadResponse,
  preflightZipFile,
  describeProgress,
  type ZipUploadResult,
  type ZipProgress,
} from '../lib/zip-upload-result';
import {
  importWhatsappExport,
  describeImportFailure,
  toUploadReport,
  type WhatsappImportReport,
} from '../lib/whatsapp-import-client';

/**
 * Imports a WhatsApp finance/petty-cash export (.zip of _chat.txt + receipt
 * images).
 *
 * The archive is expanded HERE, in the browser, and each entry is uploaded on
 * its own small request to /api/ingest/item — a whole export can never be
 * POSTed in one piece, because Vercel's edge rejects bodies over ~4.5 MB before
 * the function even runs. Doing it per item also gives every photo its own OCR
 * time budget and makes the progress count real (never a spinner: a spinner
 * can't tell a slow import from a stuck one). Every entry lands as DRAFT;
 * nothing posts to the ledger until approved in the review queue.
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

/**
 * A run that stopped early still imported real drafts, so the counts are kept
 * and the operator is told exactly how far it got and what to do about it.
 * "Nothing responded" and "you cancelled" need different first sentences.
 */
function interruptedResult(
  summary: ZipUploadResult,
  report: WhatsappImportReport,
): ZipUploadResult {
  const total = report.imageCount + report.textCount;
  const lead =
    report.interruptedReason === 'idle-timeout'
      ? `The import stalled after ${report.attempted} of ${total} files — nothing responded for several minutes, so it was stopped rather than left hanging.`
      : `The import stopped after ${report.attempted} of ${total} files.`;
  return {
    ...summary,
    ok: false,
    title: 'Import stopped early',
    message:
      `${lead} ${summary.message} ` +
      'Re-upload the same export to carry on — receipts already imported are skipped, never duplicated.',
  };
}

export const WhatsappZipUploader: React.FC = () => {
  const [status, setStatus] = useState<UploaderStatus>('IDLE');
  const [result, setResult] = useState<ZipUploadResult | null>(null);
  const [progress, setProgress] = useState<ZipProgress | null>(null);

  const cardClass = ['glass-card', status === 'DONE' ? 'is-success' : ''].filter(Boolean).join(' ');

  const reset = () => {
    setStatus('IDLE');
    setResult(null);
    setProgress(null);
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

    try {
      // The inactivity watchdog lives inside importWhatsappExport, so it
      // applies to every caller and cannot be forgotten here.
      const report = await importWhatsappExport(file, { onProgress: setProgress });

      const summary = summarizeZipUploadResponse(200, { report: toUploadReport(report) });
      const final = report.interrupted ? interruptedResult(summary, report) : summary;
      setResult(final);
      setStatus(final.ok ? 'DONE' : 'ERROR');
    } catch (err) {
      // Only archive-level rejections reach here; per-file problems are
      // reported inside the summary above, never as a dead end.
      console.error('[WhatsappZipUploader]', err);
      setResult({ ...describeImportFailure(err), ...EMPTY_COUNTS });
      setStatus('ERROR');
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
              Keep this tab open while it runs — receipts are imported one at a time and you can see
              the count. If it stops early, just upload the same file again: it picks up where it
              left off and never imports the same receipt twice.
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
