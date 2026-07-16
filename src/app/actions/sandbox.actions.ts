'use server';

import { resolveActiveContext } from '@/lib/auth-context';
import { summarizeOcrStaging, type OcrStagingSummary } from '@/lib/ocr-bridge.deps';

/**
 * S11 — staging-pile summary for /sandbox, bound to the exact same org gate
 * as POST /api/ingest/ocr-bridge: the staging pool is org-less, so it is
 * only ever shown to the one organization configured via OCR_BRIDGE_ORG_ID.
 * Unauthenticated, unconfigured, or mismatched callers get the degraded
 * "unavailable" summary — never another org's pile, never a crash.
 */
export async function fetchOcrStagingSummary(): Promise<OcrStagingSummary> {
  const unavailable: OcrStagingSummary = {
    available: false,
    importable: 0,
    parked: [],
    alreadyImported: 0,
    total: 0,
  };

  const resolved = await resolveActiveContext();
  if (!resolved.ok) return unavailable;

  const bridgeOrgId = process.env.OCR_BRIDGE_ORG_ID;
  if (!bridgeOrgId || resolved.context.organizationId !== bridgeOrgId) {
    return unavailable;
  }

  return summarizeOcrStaging(resolved.context.organizationId);
}
