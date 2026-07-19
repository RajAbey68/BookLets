import type { ZipIngestReport } from './zip-ingest';

/**
 * Turns the raw HTTP response from POST /api/ingest/zip into a single,
 * non-technical result the operator can act on. Kept as a pure function (no
 * React, no fetch) so it is unit-testable in the node-only test env — the
 * WhatsappZipUploader component is thin glue over this.
 */
export interface ZipUploadResult {
  ok: boolean;
  /** Short heading, e.g. "Import complete". */
  title: string;
  /** One-line plain-language summary. */
  message: string;
  created: number;
  deduped: number;
  skipped: number;
  failed: number;
  /** True only when new drafts landed and the review queue is worth opening. */
  showReviewLink: boolean;
}

const MB_LIMIT_HINT = 'That file is over the 100 MB limit.';

/** Mirror of the server's MAX_ZIP_UPLOAD_BYTES so we can reject before uploading. */
export const MAX_ZIP_BYTES = 100 * 1024 * 1024;

/**
 * Mirror of the server's MAX_INGEST_IMAGES (zip-ingest.ts) for client copy.
 * Kept here because this module is client-bundle-safe; zip-ingest.ts is not.
 */
export const MAX_ZIP_IMAGES = 30;

const NO_COUNTS = { created: 0, deduped: 0, skipped: 0, failed: 0, showReviewLink: false };

/**
 * Client-side pre-check run before the file leaves the browser. Returns a
 * failure result to display, or `null` when the file is safe to upload — so a
 * 500 MB or wrong-type file never wastes a full multipart round-trip to hit the
 * server's 413/400. The server still enforces the same limits authoritatively.
 */
export function preflightZipFile(name: string, size: number): ZipUploadResult | null {
  if (!name.toLowerCase().endsWith('.zip')) {
    return {
      ok: false,
      title: 'Not a .zip file',
      message: 'Pick the .zip WhatsApp export (Export Chat → Attach Media).',
      ...NO_COUNTS,
    };
  }
  if (size <= 0) {
    return { ok: false, title: 'Empty file', message: 'That file is empty.', ...NO_COUNTS };
  }
  if (size > MAX_ZIP_BYTES) {
    return {
      ok: false,
      title: 'File too large',
      message: `That file is ${(size / 1024 / 1024).toFixed(1)} MB — over the 100 MB limit.`,
      ...NO_COUNTS,
    };
  }
  return null;
}

/** Prefer the server's own error text; fall back to a friendly default. */
function errorText(body: unknown, fallback: string): string {
  if (
    body &&
    typeof body === 'object' &&
    'error' in body &&
    typeof (body as { error: unknown }).error === 'string' &&
    (body as { error: string }).error.trim().length > 0
  ) {
    return (body as { error: string }).error;
  }
  return fallback;
}

function extractReport(body: unknown): ZipIngestReport | null {
  if (
    body &&
    typeof body === 'object' &&
    'report' in body &&
    (body as { report: unknown }).report &&
    typeof (body as { report: unknown }).report === 'object'
  ) {
    return (body as { report: ZipIngestReport }).report;
  }
  return null;
}

function pluralEntries(n: number): string {
  return `${n} draft ${n === 1 ? 'entry' : 'entries'} created`;
}

function summarizeSuccess(r: ZipIngestReport): ZipUploadResult {
  const created = r.created ?? 0;
  const deduped = r.deduped ?? 0;
  const skipped = Array.isArray(r.skipped) ? r.skipped.length : 0;
  const failed = Array.isArray(r.failures) ? r.failures.length : 0;

  const extras: string[] = [];
  if (deduped > 0) extras.push(`${deduped} duplicate${deduped === 1 ? '' : 's'} skipped`);
  if (skipped > 0) extras.push(`${skipped} file${skipped === 1 ? '' : 's'} skipped`);
  if (failed > 0) extras.push(`${failed} failed`);
  const tail = extras.length ? ` · ${extras.join(' · ')}` : '';

  if (created === 0) {
    // Valid upload, but nothing new landed in the sandbox.
    const message =
      deduped > 0
        ? `No new entries — all ${deduped} were duplicates already in your books.`
        : 'Nothing new to import from this archive.';
    return {
      ok: true,
      title: 'Nothing new to import',
      message: message + (skipped > 0 || failed > 0 ? tail : ''),
      created,
      deduped,
      skipped,
      failed,
      showReviewLink: false,
    };
  }

  return {
    ok: true,
    title: 'Import complete',
    message: `${pluralEntries(created)}${tail}. Review them before posting.`,
    created,
    deduped,
    skipped,
    failed,
    showReviewLink: true,
  };
}

const EMPTY_COUNTS = { created: 0, deduped: 0, skipped: 0, failed: 0, showReviewLink: false };

export function summarizeZipUploadResponse(status: number, body: unknown): ZipUploadResult {
  if (status === 200) {
    const report = extractReport(body);
    if (report) return summarizeSuccess(report);
    // 200 without a report is unexpected — treat as a generic failure.
    return { ok: false, title: 'Something went wrong', message: 'Import failed — please try again.', ...EMPTY_COUNTS };
  }

  switch (status) {
    case 401:
      return { ok: false, title: 'Session expired', message: 'Please sign in again to import.', ...EMPTY_COUNTS };
    case 413:
      return { ok: false, title: 'File too large', message: errorText(body, MB_LIMIT_HINT), ...EMPTY_COUNTS };
    case 400:
      return {
        ok: false,
        title: 'Not a valid file',
        message: errorText(body, "That doesn't look like a WhatsApp export .zip."),
        ...EMPTY_COUNTS,
      };
    case 422:
      return {
        ok: false,
        title: 'Archive rejected',
        message: errorText(body, 'The archive failed a safety check and was not imported.'),
        ...EMPTY_COUNTS,
      };
    default:
      return { ok: false, title: 'Something went wrong', message: 'Import failed — please try again.', ...EMPTY_COUNTS };
  }
}
