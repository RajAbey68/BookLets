'use server';

import { prisma } from '@/lib/prisma';
import { resolveActiveContext } from '@/lib/auth-context';
import { fetchOcrStagingSummary } from '@/app/actions/sandbox.actions';
import {
  ACTION_EVENT_TYPES,
  deriveActionItems,
  type ActionItem,
} from '@/lib/action-centre';

export interface ActionCentreData {
  /**
   * True only when the inputs could NOT be gathered (unauthenticated or a
   * lookup failed). Distinguishes an outage from a healthy org with nothing
   * pending — the panel renders a quiet degraded line, never a crash and
   * never a false "all caught up" (mirrors fetchBooksView's discriminator).
   */
  unavailable: boolean;
  items: ActionItem[];
}

const UNAVAILABLE_ACTION_CENTRE: ActionCentreData = { unavailable: true, items: [] };

/** Newest evidence rows considered; the pure layer applies the 24h window. */
const EVIDENCE_SLICE = 10;

/**
 * Inputs for the action-centre panel, org-scoped via resolveActiveContext
 * (same pattern as books.actions — the organisation comes from the session,
 * never from client input):
 *   - DRAFT journal entries awaiting the four-eyes queue,
 *   - the staging-pile summary, REUSED from fetchOcrStagingSummary (which
 *     carries its own OCR_BRIDGE_ORG_ID gate and degrades to unavailable),
 *   - the last few ingest/approval EvidenceLog rows for activity lines.
 * All ranking/wording lives in the pure deriveActionItems.
 */
export async function fetchActionCentre(): Promise<ActionCentreData> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return UNAVAILABLE_ACTION_CENTRE;

  const { organizationId } = resolved.context;

  try {
    const [draftsAwaitingApproval, staging, recentEvents] = await Promise.all([
      prisma.journalEntry.count({ where: { organizationId, status: 'DRAFT' } }),
      fetchOcrStagingSummary(),
      prisma.evidenceLog.findMany({
        where: { tenantId: organizationId, eventType: { in: [...ACTION_EVENT_TYPES] } },
        orderBy: { createdAt: 'desc' },
        take: EVIDENCE_SLICE,
        select: { eventType: true, createdAt: true, description: true, payload: true },
      }),
    ]);

    return {
      unavailable: false,
      items: deriveActionItems({
        draftsAwaitingApproval,
        staging,
        recentEvents,
        now: new Date(),
      }),
    };
  } catch (error) {
    console.error('[action-centre.actions] fetchActionCentre failed:', error);
    return UNAVAILABLE_ACTION_CENTRE;
  }
}
