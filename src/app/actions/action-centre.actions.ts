'use server';

import { prisma } from '@/lib/prisma';
import { resolveActiveContext } from '@/lib/auth-context';
import { fetchOcrStagingSummary } from '@/app/actions/sandbox.actions';
import { isStagingOutage } from '@/lib/ocr-bridge.deps';
import {
  ACTION_EVENT_TYPES,
  deriveActionItems,
  type ActionItem,
} from '@/lib/action-centre';

export interface ActionCentreData {
  /**
   * True only when the inputs could NOT be gathered (unauthenticated, or a
   * lookup actually failed). Distinguishes an outage from a healthy org with
   * nothing pending — the panel renders a quiet degraded line, never a crash
   * and never a false "all caught up" (mirrors fetchBooksView's
   * discriminator).
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
 *     carries its own OCR_BRIDGE_ORG_ID gate),
 *   - the last few ingest/approval EvidenceLog rows for activity lines.
 * All ranking/wording lives in the pure deriveActionItems.
 *
 * Two failure rules, and the difference between them matters:
 *
 *  - Anything that BREAKS — a rejected query, a rejected session lookup, or a
 *    staging summary tagged as a real outage — degrades the whole panel to
 *    `unavailable`. A silent failure that renders as a calm "all caught up"
 *    is the exact accident this panel was built to stop.
 *  - Staging being merely NOT APPLICABLE (unauthenticated for the pile,
 *    OCR_BRIDGE_ORG_ID unset, or a different org) is not a failure. It is the
 *    normal state of this deployment, so the panel carries on and shows
 *    drafts and recent activity; deriveActionItems already refuses to invent
 *    staged/parked lines from an unavailable summary's zeros. Degrading here
 *    would pin a permanent false alarm to the dashboard and teach Raj to
 *    ignore the one panel that is supposed to be worth reading.
 *
 * resolveActiveContext runs INSIDE the guard: it returns {ok:false} by
 * contract, but it also does IO (session + Membership lookup), and a rejection
 * must degrade the panel rather than take down the page hosting it.
 */
export async function fetchActionCentre(): Promise<ActionCentreData> {
  try {
    const resolved = await resolveActiveContext();
    if (!resolved.ok) return UNAVAILABLE_ACTION_CENTRE;

    const { organizationId } = resolved.context;

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

    if (isStagingOutage(staging)) {
      console.error(
        '[action-centre.actions] staging summary unavailable (%s) — degrading the panel.',
        staging.unavailableReason,
      );
      return UNAVAILABLE_ACTION_CENTRE;
    }

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
