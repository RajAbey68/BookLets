import type { ZipIngestReport, IngestFailure } from './zip-ingest';
import type { ImportInterruptedReason } from './whatsapp-import-client';
import {
  MAX_DIRECT_UPLOAD_BYTES,
  OVERSIZE_UPLOAD_HELP,
  describeOversizeUpload,
  formatMb,
} from './upload-limits';

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

/**
 * Lead sentence for a 413 whose body told us nothing. Vercel's edge answers an
 * oversized body with plain text, not JSON, so `res.json()` throws and the
 * caller has no server message to show — this must stand on its own.
 */
const TOO_LARGE_LEAD =
  'That file was too big to upload — it was rejected in transit and never reached BookLets.';

/**
 * The single, honest upload ceiling. Kept as a named re-export because the
 * old name is referenced elsewhere; new code should import
 * MAX_DIRECT_UPLOAD_BYTES from ./upload-limits directly.
 *
 * This is NOT a mirror of the server's MAX_ZIP_UPLOAD_BYTES (100 MB) — that
 * number is unreachable on Vercel and was the cause of the silent-failure
 * incident. See src/lib/upload-limits.ts for the measured evidence.
 */
export const MAX_ZIP_BYTES = MAX_DIRECT_UPLOAD_BYTES;

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
 * Checks true of EVERY transport: it has to be a zip, and it has to have
 * bytes in it. Size ceilings differ per transport and are applied by the two
 * exported wrappers below.
 */
function preflightZipShape(name: string, size: number): ZipUploadResult | null {
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
  return null;
}

/**
 * Ceiling for an archive the BROWSER expands itself (the per-item transport
 * in whatsapp-import-client.ts).
 *
 * MAX_DIRECT_UPLOAD_BYTES deliberately does NOT apply here. Those 4 MB are a
 * limit on one request BODY, and under this transport the archive's own bytes
 * never cross the network — only its individual entries do, each capped at
 * MAX_ITEM_BYTES (src/lib/ingest-limits.ts, also 4 MB) by the browser plan and
 * re-checked by the server. Applying the request-body ceiling to the archive
 * would reject every real "Export Chat → Attach Media" export (tens of MB) and
 * so reinstate exactly the dead end this transport exists to remove.
 *
 * What still bounds the archive is what a browser tab can decompress without
 * running out of memory, which is the same 100 MB the server's
 * MAX_ZIP_UPLOAD_BYTES names. Inlined rather than imported because zip-ingest
 * pulls in adm-zip/node:crypto and can never enter the client bundle.
 */
export const MAX_EXPANDED_ARCHIVE_BYTES = 100 * 1024 * 1024;

/**
 * Client-side pre-check for the DIRECT transport — the whole archive posted as
 * one request body to /api/ingest/zip.
 *
 * The size branch is load-bearing, not cosmetic: a body over the platform
 * ceiling is killed at the edge before our route runs, so there is no server
 * error to fall back on and nothing lands in the runtime logs. Catching it
 * here is the only place the operator can be told the truth immediately.
 * The server still enforces every limit authoritatively — this is a courtesy,
 * never a trust boundary.
 */
export function preflightZipFile(name: string, size: number): ZipUploadResult | null {
  const shape = preflightZipShape(name, size);
  if (shape) return shape;
  if (size > MAX_DIRECT_UPLOAD_BYTES) {
    return {
      ok: false,
      title: 'File too large to upload',
      message: describeOversizeUpload(size),
      ...NO_COUNTS,
    };
  }
  return null;
}

/**
 * Client-side pre-check for the EXPANDED transport — the browser unzips the
 * archive and posts one small request per entry.
 *
 * Same shape checks and same error copy as preflightZipFile; only the size
 * ceiling differs, and for the reason spelled out on
 * MAX_EXPANDED_ARCHIVE_BYTES: nothing here is bounded by the platform's
 * request-body limit, because the archive is never a request body.
 */
export function preflightExpandedZipFile(name: string, size: number): ZipUploadResult | null {
  const shape = preflightZipShape(name, size);
  if (shape) return shape;
  if (size > MAX_EXPANDED_ARCHIVE_BYTES) {
    return {
      ok: false,
      title: 'File too large',
      message:
        `That file is ${formatMb(size)} — over the ${MAX_EXPANDED_ARCHIVE_BYTES / 1024 / 1024} MB ` +
        'limit for one import. Export a shorter date range (a month at a time) and import the ' +
        'parts one after another — receipts already imported are skipped, never duplicated.',
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

/**
 * Friendly, specific phrasing for a batch of failures (surfaced so "1 failed"
 * isn't a blank).
 *
 * The whole clause is stage-derived, not just a parenthetical: with the
 * per-item transport an entry can fail before the server ever looks at it
 * (`stage: 'upload'`), and calling that "couldn't be read" sends the operator
 * hunting for an unreadable photo that is in fact perfectly fine. Mixed stages
 * get neutral wording rather than the first stage speaking for all of them.
 */
function describeFailures(failures: IngestFailure[], failed: number): string {
  const stages = new Set(failures.map((f) => f.stage));
  if (stages.size > 1) return `${failed} could not be imported`;
  // `stage: 'ocr'` now means ONE thing: the service answered and the amount on
  // that photo was not legible. Provider faults — throttling, a spent quota, an
  // outage, rejected credentials — never reach this list at all: they stop the
  // run and are reported as the service's problem, because they are not facts
  // about any receipt. The old wording, "(OCR service could not read them)",
  // described a service failure and was applied to 225 perfectly good photos,
  // sending the operator to look at the one thing that was not broken.
  if (stages.has('ocr'))
    return `${failed} couldn't be read from the photo — enter those by hand`;
  if (stages.has('ledger')) return `${failed} couldn't be saved to the ledger`;
  if (stages.has('upload')) return `${failed} couldn't be uploaded (the request did not reach the server)`;
  return `${failed} could not be imported`;
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
    parts.push(describeFailures(failures, failed));
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

/**
 * Just enough of a WhatsappImportReport to write the copy for a run that
 * stopped early. Narrowed to these four fields on purpose: this module is
 * client-bundle-safe and must not pull in the transport (which imports
 * zip-reader and its browser-only DecompressionStream).
 */
export interface InterruptedImport {
  /** Items actually attempted before the run stopped. */
  attempted: number;
  /** Items the run intended to attempt (images + chat transcripts). */
  total: number;
  interruptedReason: ImportInterruptedReason | null;
  /** The service's own one-line explanation, when there is one. */
  interruptedDetail: string | null;
}

/**
 * Operator-facing copy for a run that stopped before it finished.
 *
 * Lives here, next to the rest of the plain-language copy and away from React,
 * because these sentences are the ENTIRE user-visible difference between the
 * four ways an import can be cut short — and the one that was wrong sent a
 * non-developer looking at his photographs for three days. They are testable
 * only if they are not buried in a component.
 *
 * A run that stopped early still imported real drafts, so the counts are kept
 * and the operator is told exactly how far it got and what to do about it.
 */
export function describeInterruptedImport(
  summary: ZipUploadResult,
  report: InterruptedImport,
): ZipUploadResult {
  const { attempted, total } = report;
  const notAttempted = Math.max(0, total - attempted);

  // The account's OCR quota is spent. This is the case that produced "225
  // couldn't be read", and it is the one where the operator must NOT be told
  // to wait and try again: the allowance is gone, the key is not his, and
  // there is nothing he can do to read more receipts right now. Say that
  // plainly instead of inventing a fix he cannot perform.
  if (report.interruptedReason === 'ocr-quota-exhausted') {
    return {
      ...summary,
      ok: false,
      title: 'Stopped — the OCR service’s API quota is used up',
      message:
        `The import stopped after ${attempted} of ${total} files, and ${notAttempted} were not attempted. ` +
        'Your receipts are fine — they were not read, and none was rejected. ' +
        'The receipt-reading service has used up its API quota, which is an account limit on that ' +
        'service’s own key, not anything about your photos or your books. It is raised by enabling ' +
        'billing on that key; until then a large import cannot finish, however many times it is tried. ' +
        `${summary.message} ` +
        'Whatever already imported is safe, and re-uploading the same export later carries on where ' +
        'it stopped — receipts already imported are skipped, never duplicated.',
    };
  }

  // A passing throttle. Here — and only here — "wait, then re-run" is honest.
  // He must still NOT be told his receipts were unreadable, go hunting for bad
  // photos, or re-shoot them. Nothing was wrong with them.
  if (report.interruptedReason === 'ocr-rate-limited') {
    return {
      ...summary,
      ok: false,
      title: 'Paused — OCR service is rate limited',
      message:
        `The import paused after ${attempted} of ${total} files because the OCR service ` +
        `hit its rate limit; ${notAttempted} were not attempted. ` +
        'Your receipts are fine — they were not read, not rejected. ' +
        `${summary.message} ` +
        'Wait a minute or two and upload the same export again to carry on where it stopped — ' +
        'receipts already imported are skipped, never duplicated.',
    };
  }

  // The service is down or its credentials are rejected. Same reassurance about
  // the receipts, but different advice again: waiting may not be enough, so say
  // who can fix it rather than sending the operator round a retry loop.
  if (report.interruptedReason === 'ocr-unavailable') {
    return {
      ...summary,
      ok: false,
      title: 'Stopped — OCR service is unavailable',
      message:
        `The import stopped after ${attempted} of ${total} files because the receipt-reading ` +
        `service could not be reached; ${notAttempted} were not attempted. ` +
        'Your receipts are fine — they were not read, not rejected. ' +
        `${summary.message} ` +
        'Try again shortly; if it keeps happening the OCR service needs attention from an ' +
        'administrator. Whatever already imported is safe, and re-uploading never duplicates it.',
    };
  }

  const lead =
    report.interruptedReason === 'idle-timeout'
      ? `The import stalled after ${attempted} of ${total} files — nothing responded for several minutes, so it was stopped rather than left hanging.`
      : `The import stopped after ${attempted} of ${total} files.`;
  return {
    ...summary,
    ok: false,
    title: 'Import stopped early',
    message:
      `${lead} ${summary.message} ` +
      'Re-upload the same export to carry on — receipts already imported are skipped, never duplicated.',
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
    case 403:
      return {
        ok: false,
        title: 'Not allowed',
        message: errorText(body, "Your role can't upload receipts here."),
        ...EMPTY_COUNTS,
      };
    // 413 arrives from TWO places with two different body shapes:
    //   • our own route ({ error }) once the request reached the function, and
    //   • the platform edge, as PLAIN TEXT ("FUNCTION_PAYLOAD_TOO_LARGE"),
    //     before the function ran at all — `res.json()` throws there, so
    //     callers hand us `{}` / a raw string / null / undefined.
    // Either way the operator needs the workaround, so it is always appended
    // and the raw platform text is never surfaced.
    case 413:
      return {
        ok: false,
        title: 'File too large to upload',
        message: `${errorText(body, TOO_LARGE_LEAD)} ${OVERSIZE_UPLOAD_HELP}`,
        ...EMPTY_COUNTS,
      };
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
