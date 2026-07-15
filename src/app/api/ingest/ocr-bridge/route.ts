import { NextResponse } from 'next/server';
import { resolveActiveContext } from '@/lib/auth-context';
import { runOcrBridgeImport } from '@/lib/ocr-bridge.deps';
import { DEFAULT_BATCH_SIZE } from '@/lib/ocr-bridge';

export const dynamic = 'force-dynamic';

/** Serverless guard: one batch must comfortably fit the function time budget. */
const MAX_BATCH_SIZE = 200;

/**
 * Roles allowed to trigger the import. Membership.role is a plain string;
 * the codebase's documented values are OWNER | BOOKKEEPER | ACCOUNTANT |
 * VIEWER (prisma/schema.prisma). Only OWNER (plus ADMIN, should that role
 * ever be introduced) may run an org-wide ledger import.
 */
const IMPORT_ALLOWED_ROLES = new Set(['OWNER', 'ADMIN']);

/**
 * S1b — admin-triggered staging→ledger bridge
 * (docs/runs/S1B-BRIDGE-CONTRACT.md).
 *
 * POST /api/ingest/ocr-bridge  { batchSize?: number }
 *
 * Imports the next batch of `raj_fin_track.ocr_receipts` rows as DRAFT
 * journal entries and returns the run summary
 * ({posted, skipped_existing, failed, parked, parkedPermanently, remaining}).
 * Idempotent — re-invoke until `remaining` is 0. `remaining` counts only rows
 * still importable in principle: rows parked for deterministic reasons
 * (OCR_FAILED / BAD_AMOUNT / NO_DOC_DATE / FX_UNSUPPORTED / NO_FISCAL_PERIOD)
 * are excluded, so the re-invoke loop always terminates.
 *
 * Authorization: requires an authenticated OWNER/ADMIN member (401/403), and
 * — because the staging pool is org-less (see ocr-bridge.deps.ts) — the
 * caller's organization must match OCR_BRIDGE_ORG_ID (503 when unset, 403 on
 * mismatch). The import is scoped to the caller's organization.
 */
export async function POST(request: Request) {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 401 });
  }

  if (!IMPORT_ALLOWED_ROLES.has(resolved.context.role)) {
    return NextResponse.json(
      { error: 'Only OWNER or ADMIN members may trigger the OCR bridge import.' },
      { status: 403 },
    );
  }

  // The staging pool carries no organization column, so the bridge is bound
  // to exactly one org by configuration — fail closed when unconfigured.
  const bridgeOrgId = process.env.OCR_BRIDGE_ORG_ID;
  if (!bridgeOrgId) {
    return NextResponse.json(
      { error: 'OCR bridge is not configured (OCR_BRIDGE_ORG_ID unset).' },
      { status: 503 },
    );
  }
  if (resolved.context.organizationId !== bridgeOrgId) {
    return NextResponse.json(
      { error: 'The OCR bridge staging pool is not bound to your organization.' },
      { status: 403 },
    );
  }

  // Body is optional; an empty or non-JSON body means "use defaults".
  let body: unknown = {};
  try {
    const text = await request.text();
    if (text.trim() !== '') body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  // JSON.parse accepts 'null', arrays and primitives — reject anything that
  // is not a plain object before dereferencing body.batchSize.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json(
      { error: 'Request body must be a JSON object.' },
      { status: 400 },
    );
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
