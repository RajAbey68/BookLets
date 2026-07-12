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
};

export async function POST(request: Request) {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 401 });
  }
  const { organizationId, userId } = resolved.context;

  // Cheap first-line size gate on the declared length, before buffering.
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ZIP_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `Upload exceeds the ${MAX_ZIP_UPLOAD_BYTES / (1024 * 1024)} MB zip limit.` },
      { status: 413 },
    );
  }

  let zipBuffer: Buffer;
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: 'Missing zip upload: send the archive as the "file" form field.' },
        { status: 400 },
      );
    }
    zipBuffer = Buffer.from(await file.arrayBuffer());
  } else {
    zipBuffer = Buffer.from(await request.arrayBuffer());
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

  try {
    const report = await ingestZip(
      zipBuffer,
      { organizationId, userId },
      buildDefaultZipIngestDeps(),
    );
    return NextResponse.json({ report });
  } catch (err) {
    if (err instanceof ZipIngestError) {
      console.warn(
        `[ingest/zip] rejected: ${err.code} org=${organizationId} bytes=${zipBuffer.length}`,
      );
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: GUARD_HTTP_STATUS[err.code] },
      );
    }
    console.error('[ingest/zip] ingestion failed:', err);
    return NextResponse.json({ error: 'Zip ingestion failed.' }, { status: 500 });
  }
}
