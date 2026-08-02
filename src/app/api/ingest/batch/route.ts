import { NextResponse } from 'next/server';
import { resolveActiveContext } from '@/lib/auth-context';
import { completeBatch, isValidBatchId, sanitizeLabel } from '@/lib/ingest-item';
import { buildDefaultBatchSummaryDeps } from '@/lib/ingest-item.deps';

export const dynamic = 'force-dynamic';

/**
 * POST /api/ingest/batch — close one client-driven import run.
 *
 * The single-request zip route wrote one ZIP_INGEST_COMPLETED evidence row per
 * archive ("N drafts created, M deduped"). Now that an archive arrives as many
 * small item requests, that per-archive record is rebuilt here.
 *
 * The counts are recomputed SERVER-SIDE from the per-item evidence rows this
 * organisation actually wrote for this batch. A tally in the request body is
 * ignored entirely — an audit record must state what the server did, not what
 * a browser claims happened.
 *
 * This endpoint is intentionally forgiving: by the time it is called the DRAFT
 * entries are already safely in the ledger, so a failure to write the summary
 * must not be reported to the operator as a failed import (that would send him
 * re-uploading for no reason). It answers 200 with summaryRecorded:false.
 */
export async function POST(request: Request) {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 401 });
  }
  const { organizationId, userId } = resolved.context;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
  }

  const { batchId, archiveName } = body as { batchId?: unknown; archiveName?: unknown };
  if (!isValidBatchId(batchId)) {
    return NextResponse.json(
      { error: 'The import batch id is missing or malformed.', code: 'INVALID_BATCH_ID' },
      { status: 400 },
    );
  }

  const result = await completeBatch(
    { organizationId, userId },
    batchId,
    sanitizeLabel(archiveName),
    buildDefaultBatchSummaryDeps(),
  );

  return NextResponse.json(result);
}
