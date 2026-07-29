import { NextResponse } from 'next/server';
import { resolveActiveContext } from '@/lib/auth-context';
import {
  ingestItem,
  ItemIngestError,
  MAX_ITEM_BYTES,
  isValidBatchId,
} from '@/lib/ingest-item';
import { buildDefaultItemIngestDeps, itemRateLimiter } from '@/lib/ingest-item.deps';
import { OcrError } from '@/lib/ocr-errors';

export const dynamic = 'force-dynamic';
/**
 * One item per request means one OCR call per invocation, so the whole 60 s
 * budget belongs to a single photo instead of being shared by up to 30 of them.
 * That is what removes the half-finished-import failure mode the single-shot
 * zip route had: there is no batch left to time out mid-way.
 */
export const maxDuration = 60;

/**
 * POST /api/ingest/item — one WhatsApp archive entry per request.
 *
 * WHY THIS ENDPOINT EXISTS
 * Vercel's edge rejects request bodies over ~4.5 MB with
 * 413 FUNCTION_PAYLOAD_TOO_LARGE before the function runs (measured against
 * production: 4 MB reaches the handler, 5 MB does not). A real WhatsApp
 * "Export Chat → Attach Media" archive is tens of MB, so POST /api/ingest/zip
 * could never receive one and no receipt has ever been imported. The browser
 * therefore expands the archive locally (src/lib/zip-reader.ts) and posts each
 * entry here on its own small request.
 *
 * TRUST BOUNDARY
 * The client now does the expanding, so nothing it sends is trusted:
 *   • the organisation comes from the signed-in session, never the request;
 *   • the filename is sanitised server-side (traversal → 422);
 *   • the type allowlist is re-checked by extension AND by real magic bytes;
 *   • the size cap is enforced twice — the body stream is aborted at the cap,
 *     and the decoded part is re-measured before anything is spent on it;
 *   • the dedup key is derived from a hash the SERVER computes over the bytes
 *     it received; a client-supplied hash is never accepted.
 * Every entry lands as DRAFT. Nothing here can post to the ledger.
 */

/** Body ceiling: one capped item plus multipart framing overhead. */
const MAX_ITEM_REQUEST_BYTES = MAX_ITEM_BYTES + 64 * 1024;

class UploadTooLargeError extends Error {}

/**
 * Aborts the body stream the moment cumulative bytes exceed the cap — BEFORE
 * formData() finishes buffering — so a chunked or spoofed Content-Length
 * upload cannot make the function pay the full memory cost first.
 */
function withByteCap(request: Request, cap: number): Request {
  if (!request.body) return request;
  let total = 0;
  const guarded = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > cap) {
          controller.error(new UploadTooLargeError());
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Request(request, { body: guarded, duplex: 'half' } as RequestInit);
}

const tooLarge = (actualBytes?: number) =>
  NextResponse.json(
    {
      error:
        `That file is${actualBytes ? ` ${(actualBytes / (1024 * 1024)).toFixed(1)} MB —` : ''} ` +
        `over the ${(MAX_ITEM_BYTES / (1024 * 1024)).toFixed(0)} MB per-file limit. ` +
        'Re-send that receipt as a smaller photo.',
      code: 'ITEM_TOO_LARGE',
    },
    { status: 413 },
  );

export async function POST(request: Request) {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 401 });
  }
  const { organizationId, userId } = resolved.context;

  // Cheap declared-length gate before any buffering.
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ITEM_REQUEST_BYTES) {
    return tooLarge(declaredLength);
  }

  // Shape checks come BEFORE the rate limiter. A request we reject on headers
  // alone costs the server nothing, so charging it to the organisation's bucket
  // would let malformed traffic throttle a legitimate import.
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return NextResponse.json(
      { error: 'Send the archive entry as a multipart form with a "file" part.' },
      { status: 400 },
    );
  }

  // Fan-out bound (replaces the archive-wide entry cap). Still checked before
  // the body is read, so a throttled caller never costs us the buffering.
  if (!itemRateLimiter.tryConsume(organizationId)) {
    return NextResponse.json(
      {
        error: 'Too many uploads at once — the import will slow down and continue. Try again in a moment.',
        code: 'RATE_LIMITED',
      },
      { status: 429, headers: { 'retry-after': '10' } },
    );
  }

  let form: FormData;
  try {
    form = await withByteCap(request, MAX_ITEM_REQUEST_BYTES).formData();
  } catch (err) {
    if (
      err instanceof UploadTooLargeError ||
      (err instanceof Error && err.cause instanceof UploadTooLargeError)
    ) {
      return tooLarge();
    }
    return NextResponse.json({ error: 'The upload could not be read.' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: 'Missing upload: send the archive entry as the "file" form field.' },
      { status: 400 },
    );
  }

  // The batch id is only a correlation label in the audit trail, but it is
  // client text, so it must match the server's shape before it is stored.
  const rawBatchId = form.get('batchId');
  let batchId: string | undefined;
  if (rawBatchId !== null && rawBatchId !== '') {
    if (!isValidBatchId(rawBatchId)) {
      return NextResponse.json(
        { error: 'The import batch id is malformed.', code: 'INVALID_BATCH_ID' },
        { status: 400 },
      );
    }
    batchId = rawBatchId;
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  // Authoritative size gate on the decoded part (the stream cap above covers
  // the whole body including framing; this covers the file itself).
  if (bytes.length > MAX_ITEM_BYTES) {
    return tooLarge(bytes.length);
  }

  try {
    const item = await ingestItem(bytes, file.name, { organizationId, userId }, buildDefaultItemIngestDeps(), {
      batchId,
    });
    return NextResponse.json({ item });
  } catch (err) {
    // The OCR provider throttled us, or rejected our credentials. Neither is a
    // fact about this receipt, so it must not come back as a per-item verdict
    // the client records as "unreadable".
    //
    // A rate limit is answered with a real 429 plus retry-after, which is
    // exactly what uploadItem() in whatsapp-import-client.ts already knows how
    // to pace itself against — the backoff machinery existed, the server just
    // never spoke the status that triggers it. Re-running the import resumes
    // where it stopped: dedup is keyed on content, and a throttled entry never
    // got a journal entry or an evidence row.
    if (err instanceof OcrError && err.kind === 'rate-limit') {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((err.retryAfterMs ?? 10_000) / 1000),
      );
      console.warn(
        `[ingest/item] OCR rate limited org=${encodeURIComponent(organizationId)} retryAfter=${retryAfterSeconds}s`,
      );
      return NextResponse.json(
        { error: err.message, code: 'OCR_RATE_LIMITED' },
        { status: 429, headers: { 'retry-after': String(retryAfterSeconds) } },
      );
    }
    if (err instanceof OcrError && err.kind === 'auth') {
      console.error('[ingest/item] OCR credentials rejected upstream:', err.message);
      return NextResponse.json(
        { error: err.message, code: 'OCR_AUTH_FAILED' },
        { status: 503 },
      );
    }
    if (err instanceof ItemIngestError) {
      // CodeQL js/log-injection: encode interpolated values so a crafted
      // filename cannot forge extra log lines.
      console.warn(
        `[ingest/item] rejected: ${encodeURIComponent(err.code)} org=${encodeURIComponent(organizationId)} bytes=${bytes.length}`,
      );
      return NextResponse.json({ error: err.message, code: err.code }, { status: 422 });
    }
    console.error('[ingest/item] ingestion failed:', err);
    return NextResponse.json({ error: 'That receipt could not be imported.' }, { status: 500 });
  }
}
