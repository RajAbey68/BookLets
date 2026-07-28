'use server';

import { resolveActiveContext } from '@/lib/auth-context';
import {
  summarizeOcrStaging,
  unavailableStagingSummary,
  type OcrStagingSummary,
} from '@/lib/ocr-bridge.deps';

/**
 * S11 — staging-pile summary for /sandbox, bound to the exact same org gate
 * as POST /api/ingest/ocr-bridge: the staging pool is org-less, so it is
 * only ever shown to the one organization configured via OCR_BRIDGE_ORG_ID.
 * Unauthenticated, unconfigured, or mismatched callers get the degraded
 * "unavailable" summary — never another org's pile, never a crash.
 *
 * Each gate tags the summary with its own `unavailableReason` so callers can
 * tell "the bridge is not wired up for you" (all three gates below — the
 * normal state wherever OCR_BRIDGE_ORG_ID is unset) apart from "the staging
 * query broke" (`query_failed`, raised inside summarizeOcrStaging). Callers
 * that warn the user must warn on the latter only — see isStagingOutage.
 */
export async function fetchOcrStagingSummary(): Promise<OcrStagingSummary> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return unavailableStagingSummary('unauthenticated');

  const bridgeOrgId = process.env.OCR_BRIDGE_ORG_ID;
  if (!bridgeOrgId) return unavailableStagingSummary('not_configured');
  if (resolved.context.organizationId !== bridgeOrgId) {
    return unavailableStagingSummary('org_mismatch');
  }

  return summarizeOcrStaging(resolved.context.organizationId);
}
