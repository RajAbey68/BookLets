import type { ZipIngestReport, IngestFailure } from './zip-ingest';

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
  /** Receipt images seen in the archive (created + already-in-books + failed). */
  seen?: number;
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

/** One streamed progress tick (mirrors ZipIngestProgress from the server). */
export interface ZipProgress {
  done: number;
  total: number;
  name: string;
  created: number;
  failed: number;
}

/** Number-by-number progress line — deliberately NOT a spinner. */
export function describeProgress(p: ZipProgress): string {
  const extras: string[] = [];
  if (p.created > 0) extras.push(`${p.created} created`);
  if (p.failed > 0) extras.push(`${p.failed} need review`);
  const tail = extras.length ? ` · ${extras.join(' · ')}` : '';
  return `Processing ${p.done} of ${p.total} — ${p.name}${tail}`;
}

/**
 * Split an NDJSON stream buffer into complete parsed events plus the trailing
 * partial line to carry into the next chunk. Pure so the uploader's stream
 * reader stays testable in the node-only env.
 */
export function splitNdjson(buffer: string): { events: unknown[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  const events = parts
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as unknown);
  return { events, rest };
}

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

/** Friendly, specific reason for a batch of failures (surfaced so "1 failed" isn't a blank). */
function topFailureReason(failures: IngestFailure[]): string {
  if (failures.some((f) => f.stage === 'ocr')) return 'OCR service could not read them';
  if (failures.some((f) => f.stage === 'ledger')) return 'could not save to the ledger';
  return '';
}

function summarizeSuccess(r: ZipIngestReport): ZipUploadResult {
  const created = r.created ?? 0;
  const deduped = r.deduped ?? 0;
  const skipped = Array.isArray(r.skipped) ? r.skipped.length : 0;
  const failures = Array.isArray(r.failures) ? r.failures : [];
  const failed = failures.length;
  // Receipt images the archive actually contained.
  const seen = typeof r.imageCount === 'number' ? r.imageCount : created + deduped + failed;

  const base = { seen, created, deduped, skipped, failed };
  const skippedNote = skipped > 0 ? ` · ${skipped} non-receipt file${skipped === 1 ? '' : 's'} skipped` : '';

  // 1) No receipts at all in the archive.
  if (seen === 0) {
    return {
      ...base,
      ok: true,
      title: 'No receipts found',
      message:
        'No receipt images in this archive — chat text only. In WhatsApp, use Export Chat → ' +
        `Attach Media so the photos are included.${skippedNote}`,
      showReviewLink: false,
    };
  }

  // Always state, explicitly, what happened to the receipts it saw.
  const parts = [`${created} imported`, `${deduped} already in your books`];
  if (failed > 0) {
    const reason = topFailureReason(failures);
    parts.push(`${failed} couldn't be read${reason ? ` (${reason})` : ''}`);
  }
  const headline = `Saw ${seen} receipt${seen === 1 ? '' : 's'}`;
  const message = `${headline}: ${parts.join(' · ')}${skippedNote}.`;

  // 2) Receipts found but none imported AND some failed → surface as a problem,
  //    not a bland "nothing new" (this is what a broken OCR looks like).
  if (created === 0 && failed > 0) {
    return { ...base, ok: false, title: "Couldn't import these receipts", message, showReviewLink: false };
  }

  // 3) Nothing new but no failures (all duplicates) → benign.
  if (created === 0) {
    return { ...base, ok: true, title: 'Already imported', message, showReviewLink: false };
  }

  // 4) At least one new draft landed.
  return { ...base, ok: true, title: 'Import complete', message: `${message} Review them before posting.`, showReviewLink: true };
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
