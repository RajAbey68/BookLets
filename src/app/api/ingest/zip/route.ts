import { NextResponse } from 'next/server';
import { resolveActiveContext } from '@/lib/auth-context';
import {
  ingestZip,
  ZipIngestError,
  MAX_ZIP_UPLOAD_BYTES,
  type ZipIngestGuardCode,
} from '@/lib/zip-ingest';
import { buildDefaultZipIngestDeps } from '@/lib/zip-ingest.deps';

export const dynamic = 'force-dynamic';
// Raise the serverless timeout budget for the inline OCR batch. Paired with the
// MAX_INGEST_IMAGES cap in zip-ingest.ts as a stopgap until ingest is moved to
// an async worker. Vercel clamps this to the plan maximum if lower.
export const maxDuration = 60;

/**
 * S5 — POST /api/ingest/zip
 *
 * Ingests a WhatsApp finance/petty-cash export zip (chat text + receipt
 * images). Auth-gated exactly like the other API routes: the organisation
 * comes from the signed-in session via resolveActiveContext — never from
 * client input. Accepts either a multipart form with a "file" part or a raw
 * application/zip body (curl-friendly).
 *
 * All security guards (entry count, uncompressed size, path traversal,
 * zip-bomb ratio, type allowlist) run inside ingestZip BEFORE any OCR
 * spend; guard violations map to stable HTTP codes below. Every journal
 * entry created is DRAFT — four-eyes approval promotes to POSTED later.
 */
const GUARD_HTTP_STATUS: Record<ZipIngestGuardCode, number> = {
  INVALID_ZIP: 400,
  TOO_MANY_ENTRIES: 422,
  TOTAL_SIZE_EXCEEDED: 413,
  PATH_TRAVERSAL: 422,
  ZIP_BOMB: 422,
  TOO_MANY_IMAGES: 422,
};

class UploadTooLargeError extends Error {}

/**
 * Wraps the request so its body stream aborts the moment cumulative bytes
 * exceed the cap — BEFORE formData()/arrayBuffer() finish buffering. This
 * closes the gap where a chunked or spoofed Content-Length upload pays the
 * full memory cost before the post-buffer size check runs.
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

export async function POST(request: Request) {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 401 });
  }
  const { organizationId, userId } = resolved.context;

  const tooLarge = () =>
    NextResponse.json(
      { error: `Upload exceeds the ${MAX_ZIP_UPLOAD_BYTES / (1024 * 1024)} MB zip limit.` },
      { status: 413 },
    );

  // Cheap first-line size gate on the declared length, before buffering.
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ZIP_UPLOAD_BYTES) {
    return tooLarge();
  }

  let zipBuffer: Buffer;
  const contentType = request.headers.get('content-type') ?? '';
  const capped = withByteCap(request, MAX_ZIP_UPLOAD_BYTES);
  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await capped.formData();
      const file = form.get('file');
      if (!(file instanceof File)) {
        return NextResponse.json(
          { error: 'Missing zip upload: send the archive as the "file" form field.' },
          { status: 400 },
        );
      }
      zipBuffer = Buffer.from(await file.arrayBuffer());
    } else {
      zipBuffer = Buffer.from(await capped.arrayBuffer());
    }
  } catch (err) {
    // TransformStream errors surface as the cause or the error itself
    // depending on the runtime's body-consumption path.
    if (err instanceof UploadTooLargeError || (err instanceof Error && err.cause instanceof UploadTooLargeError)) {
      return tooLarge();
    }
    throw err;
  }

  if (zipBuffer.length === 0) {
    return NextResponse.json({ error: 'Empty upload.' }, { status: 400 });
  }
  // Authoritative size gate on the actual buffered bytes.
  if (zipBuffer.length > MAX_ZIP_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `Upload exceeds the ${MAX_ZIP_UPLOAD_BYTES / (1024 * 1024)} MB zip limit.` },
      { status: 413 },
    );
  }

  const deps = buildDefaultZipIngestDeps();

  // Streaming mode: when the client asks for NDJSON, emit one progress line per
  // image (live number-by-number count — no spinner) then a terminal `done` or
  // `error` event. Auth (401) and the byte cap (413) already ran above as real
  // HTTP statuses; guard rejections inside ingestZip surface as `error` events
  // because the 200 stream is already open by the time they can fire.
  if ((request.headers.get('accept') ?? '').includes('application/x-ndjson')) {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        const write = (obj: unknown) => controller.enqueue(enc.encode(`${JSON.stringify(obj)}\n`));
        try {
          const report = await ingestZip(zipBuffer, { organizationId, userId }, deps, {}, (p) =>
            write({ type: 'progress', ...p }),
          );
          write({ type: 'done', report });
        } catch (err) {
          if (err instanceof ZipIngestError) {
            console.warn(
              `[ingest/zip] rejected: ${encodeURIComponent(err.code)} org=${encodeURIComponent(organizationId)} bytes=${zipBuffer.length}`,
            );
            write({
              type: 'error',
              status: GUARD_HTTP_STATUS[err.code],
              code: err.code,
              message: err.message,
              ...(err.meta ? { meta: err.meta } : {}),
            });
          } else {
            console.error('[ingest/zip] ingestion failed:', err);
            write({ type: 'error', status: 500, message: 'Zip ingestion failed.' });
          }
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  try {
    const report = await ingestZip(zipBuffer, { organizationId, userId }, deps);
    return NextResponse.json({ report });
  } catch (err) {
    if (err instanceof ZipIngestError) {
      // CodeQL js/log-injection: interpolated values could carry
      // attacker-influenced bytes; encode so a crafted value cannot forge
      // additional log lines (encodeURIComponent is a recognised sanitizer).
      console.warn(
        `[ingest/zip] rejected: ${encodeURIComponent(err.code)} org=${encodeURIComponent(organizationId)} bytes=${zipBuffer.length}`,
      );
      return NextResponse.json(
        { error: err.message, code: err.code, ...(err.meta ? { meta: err.meta } : {}) },
        { status: GUARD_HTTP_STATUS[err.code] },
      );
    }
    console.error('[ingest/zip] ingestion failed:', err);
    return NextResponse.json({ error: 'Zip ingestion failed.' }, { status: 500 });
  }
}
