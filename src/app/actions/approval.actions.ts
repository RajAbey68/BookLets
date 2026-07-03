'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { resolveActiveContext } from '@/lib/auth-context';
import { EvidenceLogService } from '@/lib/evidence-log.service';
import { LedgerService } from '@/lib/ledger.service';
import {
  assertNotSelfApproval,
  resolveIntentDecision,
  resolveDraftJournalDecision,
  SelfApprovalError,
  InvalidApprovalStateError,
  type ApprovalDecision,
} from '@/lib/approval.service';

export type DecisionResult = { success: true } | { success: false; error: string };

const DECISION_EVENT_TYPES = [
  'ACTION_INTENT_APPROVED',
  'ACTION_INTENT_REJECTED',
  'JOURNAL_DRAFT_APPROVED',
  'JOURNAL_DRAFT_REJECTED',
] as const;

/**
 * RAJ-292 — pending 4-eyes queue items, scoped to the caller's organisation.
 *
 * ActionIntentQueue predates multi-tenancy; this feature retrofits the
 * organizationId column (see 20260703_action_intent_org_scope). The filter is
 * strict: an intent without an organizationId is invisible everywhere rather
 * than visible to everyone.
 */
export async function fetchPendingActionIntents() {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return [];

  const { organizationId } = resolved.context;

  try {
    return await prisma.actionIntentQueue.findMany({
      where: { status: 'PENDING', organizationId },
      orderBy: { createdAt: 'asc' },
    });
  } catch (error) {
    console.error('[approval.actions] fetchPendingActionIntents failed:', error);
    return [];
  }
}

/**
 * RAJ-292 — DRAFT journal entries awaiting promotion. RevenueService parks
 * entries above the €10k threshold as DRAFT with no promotion path until now.
 */
export async function fetchDraftJournalEntries() {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return [];

  const { organizationId } = resolved.context;

  try {
    return await prisma.journalEntry.findMany({
      where: { organizationId, status: 'DRAFT' },
      include: { lines: { include: { account: true } } },
      orderBy: { date: 'desc' },
    });
  } catch (error) {
    console.error('[approval.actions] fetchDraftJournalEntries failed:', error);
    return [];
  }
}

/** Recent approval decisions from the tamper-evident EvidenceLog (audit trail). */
export async function fetchRecentDecisions(limit = 20) {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return [];

  const { organizationId } = resolved.context;

  try {
    return await prisma.evidenceLog.findMany({
      where: { tenantId: organizationId, eventType: { in: [...DECISION_EVENT_TYPES] } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  } catch (error) {
    console.error('[approval.actions] fetchRecentDecisions failed:', error);
    return [];
  }
}

/**
 * RAJ-292/294 — decide a PENDING ActionIntentQueue item.
 *
 * The approver identity comes from the session (resolveActiveContext), never
 * from client input, so self-approval cannot be spoofed. The update is
 * guarded on status PENDING so a concurrent double-decide matches zero rows
 * instead of double-writing, and the EvidenceLog row is written in the same
 * transaction — a decision cannot exist without its audit evidence.
 */
export async function decideActionIntent(
  intentId: string,
  decision: ApprovalDecision,
): Promise<DecisionResult> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return { success: false, error: resolved.error };

  const { organizationId, userId } = resolved.context;

  let intent;
  try {
    intent = await prisma.actionIntentQueue.findUnique({ where: { id: intentId } });
  } catch (error) {
    console.error('[approval.actions] decideActionIntent: lookup failed:', error);
    return { success: false, error: 'Could not load the approval item. Try again shortly.' };
  }
  // Multi-tenant isolation: an intent from another org (or with no org at all)
  // is indistinguishable from "not found" — never confirm its existence.
  if (!intent || intent.organizationId !== organizationId) {
    return { success: false, error: 'Approval item not found.' };
  }

  let nextStatus: 'APPROVED' | 'REJECTED';
  try {
    nextStatus = resolveIntentDecision(intent.status, decision);
    assertNotSelfApproval(intent.makerIdentity, userId);
  } catch (error) {
    if (error instanceof SelfApprovalError || error instanceof InvalidApprovalStateError) {
      return { success: false, error: error.message };
    }
    throw error;
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Guarded on the status we validated against: if another checker decided
      // this item between our read and this write, count === 0 and we abort.
      const updated = await tx.actionIntentQueue.updateMany({
        where: { id: intentId, status: 'PENDING', organizationId },
        data: {
          status: nextStatus,
          checkerIdentity: userId,
          ...(decision === 'APPROVE' ? { approvedAt: new Date() } : {}),
        },
      });
      if (updated.count === 0) {
        throw new InvalidApprovalStateError('This item was already decided by another approver.');
      }

      await EvidenceLogService.record(tx, {
        eventType: `ACTION_INTENT_${nextStatus}`,
        tenantId: organizationId,
        makerIdentity: intent.makerIdentity,
        checkerIdentity: userId,
        description: `Action intent "${intent.action}" ${nextStatus.toLowerCase()} by checker.`,
        payload: {
          intentId: intent.id,
          action: intent.action,
          decision,
          nextStatus,
          confidence: intent.confidence,
        },
      });
    });
  } catch (error) {
    console.error('[approval.actions] decideActionIntent: decision failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to record the decision.',
    };
  }

  revalidatePath('/approvals');
  return { success: true };
}

/**
 * RAJ-292/294 — decide a DRAFT JournalEntry (approve → POSTED, reject → VOIDED).
 *
 * Approval is NOT a validation bypass: promotion re-runs the trial-balance
 * check and the fiscal-period gate exactly as LedgerService enforces them for
 * a direct POSTED entry. Maker attribution falls back from makerIdentity to
 * createdBy so legacy drafts are still covered by the no-self-approval rule.
 */
export async function decideDraftJournalEntry(
  entryId: string,
  decision: ApprovalDecision,
): Promise<DecisionResult> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return { success: false, error: resolved.error };

  const { organizationId, userId } = resolved.context;

  let entry;
  try {
    // Org-scoped load — never trust a bare entry id from the client.
    entry = await prisma.journalEntry.findFirst({
      where: { id: entryId, organizationId },
      include: { lines: true },
    });
  } catch (error) {
    console.error('[approval.actions] decideDraftJournalEntry: lookup failed:', error);
    return { success: false, error: 'Could not load the journal entry. Try again shortly.' };
  }
  if (!entry) return { success: false, error: 'Draft journal entry not found in your organisation.' };

  const makerIdentity = entry.makerIdentity ?? entry.createdBy;

  let nextStatus: 'POSTED' | 'VOIDED';
  try {
    nextStatus = resolveDraftJournalDecision(entry.status, decision);
    assertNotSelfApproval(makerIdentity, userId);
  } catch (error) {
    if (error instanceof SelfApprovalError || error instanceof InvalidApprovalStateError) {
      return { success: false, error: error.message };
    }
    throw error;
  }

  if (decision === 'APPROVE') {
    // Same gates a directly-POSTED entry must pass (LedgerService authority).
    const validation = LedgerService.validateTrialBalance(
      entry.lines.map((l) => ({ accountId: l.accountId, amount: l.amount, isDebit: l.isDebit })),
    );
    if (!validation.isValid) {
      return { success: false, error: `Cannot post: ${validation.error}` };
    }
    try {
      await LedgerService.checkFiscalPeriod(organizationId, entry.date);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Fiscal period check failed.',
      };
    }
  }

  try {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.journalEntry.updateMany({
        where: { id: entryId, organizationId, status: 'DRAFT' },
        data: { status: nextStatus, updatedBy: userId },
      });
      if (updated.count === 0) {
        throw new InvalidApprovalStateError('This entry was already decided by another approver.');
      }

      await EvidenceLogService.record(tx, {
        eventType: decision === 'APPROVE' ? 'JOURNAL_DRAFT_APPROVED' : 'JOURNAL_DRAFT_REJECTED',
        tenantId: organizationId,
        makerIdentity: makerIdentity ?? 'unknown',
        checkerIdentity: userId,
        description: `Draft journal entry ${nextStatus === 'POSTED' ? 'approved and posted' : 'rejected and voided'}${entry.memo ? `: ${entry.memo}` : ''}`,
        payload: {
          entryId: entry.id,
          decision,
          nextStatus,
          memo: entry.memo,
          date: entry.date.toISOString(),
          lines: entry.lines.map((l) => ({
            accountId: l.accountId,
            amount: l.amount.toString(),
            isDebit: l.isDebit,
          })),
        },
      });
    });
  } catch (error) {
    console.error('[approval.actions] decideDraftJournalEntry: decision failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to record the decision.',
    };
  }

  revalidatePath('/approvals');
  revalidatePath('/ledger');
  return { success: true };
}
