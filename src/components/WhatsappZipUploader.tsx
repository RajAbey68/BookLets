'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  summarizeZipUploadResponse,
  preflightExpandedZipFile,
  describeProgress,
  describeInterruptedImport,
  type ZipUploadResult,
  type ZipProgress,
} from '../lib/zip-upload-result';
import {
  importWhatsappExport,
  describeImportFailure,
  toUploadReport,
  DEFAULT_IDLE_TIMEOUT_MS,
  type WhatsappImportReport,
} from '../lib/whatsapp-import-client';
import { describeElapsed } from '../lib/upload-limits';
import { FISCAL_PERIOD_PAGE_PATH } from '../lib/fiscal-period';

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
 *
 * Two independent liveness cues run side by side while it works, because they
 * fail in different places: the per-item COUNT proves the server is answering
 * but only moves when an item finishes (an OCR round-trip, sometimes a minute
 * apart, and not at all while the archive is still being decompressed), while
 * the ELAPSED clock ticks every second and so covers precisely those gaps. If
 * both stall, the inactivity watchdog inside importWhatsappExport ends the run
 * and says so. There is no state in which this card shows progress while
 * nothing is happening — that dead end is the whole reason this code exists.
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
 *
 * The copy itself lives in zip-upload-result.ts, next to the rest of the
 * plain-language summarising and away from React, so the four "why it
 * stopped" sentences are unit-testable. This adapter exists only to turn the
 * transport's report into the shape that function takes.
 */
function interruptedResult(
  summary: ZipUploadResult,
  report: WhatsappImportReport,
): ZipUploadResult {
  return describeInterruptedImport(summary, {
    attempted: report.attempted,
    total: report.imageCount + report.textCount,
    interruptedReason: report.interruptedReason,
    interruptedDetail: report.interruptedDetail,
  });
}

/**
 * `booksOpen: false` means the organisation has no open accounting period, so
 * the ledger would refuse every receipt in the archive. The uploader then
 * offers the fix instead of taking an upload it cannot use — the earliest
 * possible point to fail, before the archive is even expanded and long before
 * any OCR is paid for. The server enforces the same rule independently.
 */
export const WhatsappZipUploader: React.FC<{ booksOpen?: boolean }> = ({ booksOpen = true }) => {
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
    // The EXPANDED variant: this transport never posts the archive as a request
    // body, so the platform's 4 MB body ceiling is not the number to check —
    // see MAX_EXPANDED_ARCHIVE_BYTES.
    const preflight = preflightExpandedZipFile(file.name, file.size);
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

    try {
      // #132 wrapped its single fetch in a fixed DIRECT_UPLOAD_TIMEOUT_MS abort.
      // That call no longer exists, and a fixed deadline is the wrong mechanism
      // for this transport anyway: a 200-receipt run legitimately lasts half an
      // hour. The replacement is an INACTIVITY watchdog living inside
      // importWhatsappExport, so it applies to every caller and cannot be
      // forgotten here.
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

  if (!booksOpen) {
    return (
      <div className="glass-card">
        <div className="uploader">
          <div className="uploader-icon">
            <IconAlert />
          </div>
          <h3 className="uploader-title">Importing is paused</h3>
          <p className="uploader-body">
            Your books have no open accounting period, so every receipt would be refused.
            Open one — it takes one click — and this uploader comes back.
          </p>
          <Link href={FISCAL_PERIOD_PAGE_PATH} className="btn btn-primary">
            Open an accounting period
          </Link>
        </div>
      </div>
    );
  }

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
            Still working — {describeElapsed(elapsedMs)}. Kept alongside the count above because
            the count only moves when a receipt finishes; this moves every second, so silence is
            always visible. If nothing finishes for{' '}
            {Math.round(DEFAULT_IDLE_TIMEOUT_MS / 60000)} minutes the import stops and tells you,
            rather than waiting forever.
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
              Keep this tab open while it runs — receipts are imported one at a time and you can see
              the count. If it stops early, just upload the same file again: it picks up where it
              left off and never imports the same receipt twice. Exporting <em>Without Media</em>{' '}
              keeps the file small but contains no receipt photos, so it creates no entries.
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
