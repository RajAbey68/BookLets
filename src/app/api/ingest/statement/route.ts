import { NextResponse } from 'next/server';
import { resolveActiveContext } from '@/lib/auth-context';
import {
  ingestStatement,
  StatementIngestError,
  MAX_STATEMENT_UPLOAD_BYTES,
  type StatementIngestGuardCode,
} from '@/lib/statement-ingest';
import { buildDefaultStatementIngestDeps } from '@/lib/statement-ingest.deps';

export const dynamic = 'force-dynamic';

/**
 * A statement posts one DRAFT entry per row, each in its own transaction, so
 * the work scales with the row count rather than the upload size. This route
 * previously declared no budget at all and took the platform default, which a
 * few hundred rows exceed comfortably: the function was killed mid-import, the
 * client got no response at all (status 0 in the access log), and the upload
 * card — which has no timeout of its own — span forever. The sibling ingest
 * routes have carried `maxDuration = 60` since #133; this one was simply
 * missed.
 *
 * 60s is the ceiling, not the target: MAX_STATEMENT_ROWS bounds the work, and
 * the fiscal-period probes now run concurrently rather than one per distinct
 * day.
 */
export const maxDuration = 60;

/**
 * POST /api/ingest/statement
 *
 * Ingests a bank-statement CSV (Wise export auto-detected; generic
 * Date/Amount/Description mapping otherwise) as per-transaction-deduplicated
 * DRAFT journal entries. Auth-gated exactly like the other ingest routes:
 * the organisation comes from the signed-in session via resolveActiveContext
 * — never from client input. Accepts either a multipart form with a "file"
 * part or a raw text/csv body (curl-friendly).
 *
 * All guards (byte cap, row cap, header requirements) run inside
 * ingestStatement BEFORE any ledger write; guard violations map to stable
 * HTTP codes below. Every journal entry created is DRAFT — four-eyes
 * approval promotes to POSTED later.
 */
const GUARD_HTTP_STATUS: Record<StatementIngestGuardCode, number> = {
  INVALID_CSV: 400,
  MISSING_COLUMNS: 422,
  FILE_TOO_LARGE: 413,
  TOO_MANY_ROWS: 422,
};

/**
 * Roles allowed to import a statement. Membership.role is a plain string;
 * the codebase's documented values are OWNER | BOOKKEEPER | ACCOUNTANT |
 * VIEWER (prisma/schema.prisma). Only OWNER (plus ADMIN, should that role
 * ever be introduced) may run an org-wide ledger import — same gate as the
 * ocr-bridge route.
 */
const IMPORT_ALLOWED_ROLES = new Set(['OWNER', 'ADMIN']);

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
    new TransformStream({
      transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
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
  if (!IMPORT_ALLOWED_ROLES.has(resolved.context.role)) {
    return NextResponse.json(
      { error: 'Only OWNER or ADMIN members may import bank statements.' },
      { status: 403 },
    );
  }
  const { organizationId, userId } = resolved.context;

  const tooLarge = () =>
    NextResponse.json(
      {
        error: `Upload exceeds the ${MAX_STATEMENT_UPLOAD_BYTES / (1024 * 1024)} MB statement limit.`,
      },
      { status: 413 },
    );

  // Cheap first-line size gate on the declared length, before buffering.
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_STATEMENT_UPLOAD_BYTES) {
    return tooLarge();
  }

  let csvBuffer: Buffer;
  const contentType = request.headers.get('content-type') ?? '';
  const capped = withByteCap(request, MAX_STATEMENT_UPLOAD_BYTES);
  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await capped.formData();
      const file = form.get('file');
      if (!(file instanceof File)) {
        return NextResponse.json(
          { error: 'Missing statement upload: send the CSV as the "file" form field.' },
          { status: 400 },
        );
      }
      csvBuffer = Buffer.from(await file.arrayBuffer());
    } else {
      csvBuffer = Buffer.from(await capped.arrayBuffer());
    }
  } catch (err) {
    // TransformStream errors surface as the cause or the error itself
    // depending on the runtime's body-consumption path.
    if (
      err instanceof UploadTooLargeError ||
      (err instanceof Error && err.cause instanceof UploadTooLargeError)
    ) {
      return tooLarge();
    }
    throw err;
  }

  if (csvBuffer.length === 0) {
    return NextResponse.json({ error: 'Empty upload.' }, { status: 400 });
  }
  // Authoritative size gate on the actual buffered bytes (ingestStatement
  // re-checks the same cap as a guard, mapped to 413 below).
  if (csvBuffer.length > MAX_STATEMENT_UPLOAD_BYTES) {
    return tooLarge();
  }

  try {
    const report = await ingestStatement(
      csvBuffer,
      { organizationId, userId },
      buildDefaultStatementIngestDeps(),
    );
    return NextResponse.json({ report });
  } catch (err) {
    if (err instanceof StatementIngestError) {
      // CodeQL js/log-injection: interpolated values could carry
      // attacker-influenced bytes; encode so a crafted value cannot forge
      // additional log lines (encodeURIComponent is a recognised sanitizer).
      console.warn(
        `[ingest/statement] rejected: ${encodeURIComponent(err.code)} org=${encodeURIComponent(organizationId)} bytes=${csvBuffer.length}`,
      );
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: GUARD_HTTP_STATUS[err.code] },
      );
    }
    console.error('[ingest/statement] ingestion failed:', err);
    return NextResponse.json({ error: 'Statement ingestion failed.' }, { status: 500 });
  }
}
