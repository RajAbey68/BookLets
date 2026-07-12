import { NextResponse } from 'next/server';
import { resolveActiveContext } from '@/lib/auth-context';
import { runOcrBridgeImport } from '@/lib/ocr-bridge.deps';
import { DEFAULT_BATCH_SIZE } from '@/lib/ocr-bridge';

export const dynamic = 'force-dynamic';

/** Serverless guard: one batch must comfortably fit the function time budget. */
const MAX_BATCH_SIZE = 200;

/**
 * S1b — admin-triggered staging→ledger bridge
 * (docs/runs/S1B-BRIDGE-CONTRACT.md).
 *
 * POST /api/ingest/ocr-bridge  { batchSize?: number }
 *
 * Imports the next batch of `raj_fin_track.ocr_receipts` rows as DRAFT
 * journal entries and returns the run summary
 * ({posted, skipped_existing, failed, parked, remaining}). Idempotent —
 * re-invoke until `remaining` is 0. Requires an authenticated member; the
 * import is scoped to the caller's organization.
 */
export async function POST(request: Request) {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 401 });
  }

  // Body is optional; an empty or non-JSON body means "use defaults".
  let body: unknown = {};
  try {
    const text = await request.text();
    if (text.trim() !== '') body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  let batchSize = DEFAULT_BATCH_SIZE;
  const rawBatchSize = (body as { batchSize?: unknown }).batchSize;
  if (rawBatchSize !== undefined) {
    if (
      typeof rawBatchSize !== 'number' ||
      !Number.isInteger(rawBatchSize) ||
      rawBatchSize < 1 ||
      rawBatchSize > MAX_BATCH_SIZE
    ) {
      return NextResponse.json(
        { error: `batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}.` },
        { status: 400 },
      );
    }
    batchSize = rawBatchSize;
  }

  try {
    const summary = await runOcrBridgeImport(resolved.context.organizationId, batchSize);
    return NextResponse.json(summary);
  } catch (err) {
    console.error('[ocr-bridge] Import run failed:', err);
    const message = err instanceof Error ? err.message : 'Bridge import failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
