'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { resolveActiveContext } from '@/lib/auth-context';
import { EvidenceLogService } from '@/lib/evidence-log.service';
import { LedgerService } from '@/lib/ledger.service';
import {
  assertNotSelfApproval,
  isSameIdentity,
  resolveIntentDecision,
  resolveDraftJournalDecision,
  SelfApprovalError,
  InvalidApprovalStateError,
  type ApprovalDecision,
} from '@/lib/approval.service';
import { parseDraftEvidence, type ParsedDraftEvidence } from '@/lib/draft-evidence';

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
  revalidatePath('/review');
  revalidatePath('/ledger');
  return { success: true };
}

// ─── S6 review-ui — batch decisions ─────────────────────────────────────────

export interface BatchEntryResult {
  entryId: string;
  success: boolean;
  error?: string;
}

export type BatchDecisionResult =
  | { ok: true; succeeded: number; failed: number; results: BatchEntryResult[] }
  | { ok: false; error: string };

/** Bounded work per request — a checker reviews pages, not the whole ledger. */
const MAX_BATCH_SIZE = 50;

/**
 * S6 — decide several DRAFT journal entries in one submission.
 *
 * Deliberately a thin, SEQUENTIAL fan-out over decideDraftJournalEntry so
 * every 4-eyes control holds per entry with zero new enforcement code:
 * session-resolved checker identity, assertNotSelfApproval, DRAFT-only state
 * machine, org scoping, guarded update + EvidenceLog in one transaction.
 * An entry the caller made themself fails with a PER-ENTRY error and the
 * rest of the batch proceeds — exclusion, never silent approval.
 *
 * Sequential (not Promise.all) on purpose: EvidenceLog is a hash chain whose
 * record() reads the tenant's latest row; concurrent decisions would race
 * the chain head.
 */
export async function batchDecideDraftJournalEntries(
  entryIds: string[],
  decision: ApprovalDecision,
): Promise<BatchDecisionResult> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const unique = [...new Set(entryIds)].filter((id) => typeof id === 'string' && id.length > 0);
  if (unique.length === 0) {
    return { ok: false, error: 'Select at least one draft entry to decide.' };
  }
  if (unique.length > MAX_BATCH_SIZE) {
    return { ok: false, error: `Batch too large: decide at most ${MAX_BATCH_SIZE} entries at a time.` };
  }

  const results: BatchEntryResult[] = [];
  for (const entryId of unique) {
    const result = await decideDraftJournalEntry(entryId, decision);
    results.push(
      result.success ? { entryId, success: true } : { entryId, success: false, error: result.error },
    );
  }

  const succeeded = results.filter((r) => r.success).length;
  return { ok: true, succeeded, failed: results.length - succeeded, results };
}

// ─── S6 review-ui — DRAFT review queue with side-by-side evidence ───────────

export interface DraftReviewLine {
  accountName: string;
  accountCode: string | null;
  amount: string;
  isDebit: boolean;
}

/** Best-effort matched expense record (no FK exists — see fetchDraftReviewQueue). */
export interface DraftReviewExpense {
  id: string;
  vendorName: string;
  categoryName: string;
  propertyName: string;
  amount: string;
  date: string;
  description: string | null;
  confidenceScore: number | null;
  /** Schema field for a stored receipt reference — currently never written. */
  receiptCloudId: string | null;
}

export interface DraftReviewEvidence {
  id: string;
  eventType: string;
  description: string;
  makerIdentity: string;
  createdAt: string;
}

export interface DraftReviewItem {
  id: string;
  date: string;
  memo: string | null;
  makerIdentity: string | null;
  source: string | null;
  sourceId: string | null;
  agentConfidence: number | null;
  /** Headline amount = total debit side of the balanced entry. */
  amount: string;
  lines: DraftReviewLine[];
  parsed: ParsedDraftEvidence;
  expense: DraftReviewExpense | null;
  evidence: DraftReviewEvidence[];
  /** True when the session user made this entry — they cannot decide it (4-eyes). */
  isOwnDraft: boolean;
}

/**
 * S6 — DRAFT count for the sidebar "Review" badge. Degrades to 0 instead of
 * throwing: a badge must never take down the app shell it renders in.
 */
export async function fetchDraftReviewCount(): Promise<number> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return 0;

  const { organizationId } = resolved.context;

  try {
    return await prisma.journalEntry.count({ where: { organizationId, status: 'DRAFT' } });
  } catch (error) {
    console.error('[approval.actions] fetchDraftReviewCount failed:', error);
    return 0;
  }
}

/** Same calendar day in UTC — extraction dates carry no meaningful time. */
function sameUtcDay(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

/**
 * S6 — DRAFT entries with everything a checker can inspect side-by-side.
 *
 * Evidence reality (investigated, not invented):
 *  - extracted fields live in the memo (vendor/category/filename) plus
 *    agentConfidence and source/sourceId — parsed by parseDraftEvidence;
 *  - EvidenceLog rows reference the entry via payload.entryId (JSON path);
 *  - there is NO foreign key between JournalEntry and Expense, so the
 *    expense record is matched heuristically (vendor + amount + same UTC
 *    day, org-scoped via property) and labelled as such in the UI;
 *  - receipt images are NOT persisted anywhere (Expense.receiptCloudId is
 *    never written; uploads are OCR'd in-memory and discarded), so the UI
 *    shows a typed placeholder instead of pretending storage exists.
 */
export async function fetchDraftReviewQueue(
  // /review passes its page cap; /approvals omits the option and keeps the
  // full set — a shared cap would silently hide older drafts there.
  options: { limit?: number } = {},
): Promise<{ items: DraftReviewItem[] }> {
  const resolved = await resolveActiveContext();
  if (!resolved.ok) return { items: [] };

  const { organizationId, userId } = resolved.context;

  let drafts;
  try {
    drafts = await prisma.journalEntry.findMany({
      where: { organizationId, status: 'DRAFT' },
      include: { lines: { include: { account: true } } },
      // Newest first, createdAt as the same-day tiebreaker so the order is
      // stable for every caller; id breaks exact ties deterministically.
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      ...(options.limit !== undefined ? { take: options.limit } : {}),
    });
  } catch (error) {
    console.error('[approval.actions] fetchDraftReviewQueue: draft load failed:', error);
    return { items: [] };
  }
  if (drafts.length === 0) return { items: [] };

  const draftIds = drafts.map((d) => d.id);

  // EvidenceLog rows for these entries (creation + any prior decisions).
  // payload.entryId is how LedgerService and the decision actions reference
  // the entry — a JSON path filter per id, OR'd into one query.
  let evidenceRows: Awaited<ReturnType<typeof prisma.evidenceLog.findMany>> = [];
  try {
    evidenceRows = await prisma.evidenceLog.findMany({
      where: {
        tenantId: organizationId,
        OR: draftIds.map((id) => ({ payload: { path: ['entryId'], equals: id } })),
      },
      orderBy: { createdAt: 'asc' },
    });
  } catch (error) {
    // Evidence is enrichment, not a gate — the queue still renders without it.
    console.error('[approval.actions] fetchDraftReviewQueue: evidence load failed:', error);
  }
  const evidenceByEntry = new Map<string, DraftReviewEvidence[]>();
  for (const row of evidenceRows) {
    const payload = row.payload as { entryId?: unknown } | null;
    const entryId = typeof payload?.entryId === 'string' ? payload.entryId : null;
    if (!entryId) continue;
    const list = evidenceByEntry.get(entryId) ?? [];
    list.push({
      id: row.id,
      eventType: row.eventType,
      description: row.description,
      makerIdentity: row.makerIdentity,
      createdAt: row.createdAt.toISOString(),
    });
    evidenceByEntry.set(entryId, list);
  }

  // Candidate expense records, org-scoped THROUGH the property relation
  // (Expense has no organizationId column of its own).
  let expenses: Array<{
    id: string;
    amount: { toString(): string };
    date: Date;
    description: string | null;
    confidenceScore: number | null;
    receiptCloudId: string | null;
    vendor: { name: string };
    expenseCategory: { name: string };
    property: { name: string };
  }> = [];
  try {
    expenses = await prisma.expense.findMany({
      where: {
        property: { organizationId },
        date: { in: drafts.map((d) => d.date) },
      },
      include: { vendor: true, expenseCategory: true, property: true },
    });
  } catch (error) {
    console.error('[approval.actions] fetchDraftReviewQueue: expense load failed:', error);
  }

  const items: DraftReviewItem[] = drafts.map((entry) => {
    const parsed = parseDraftEvidence(entry.memo, entry.source);
    const debitTotal = entry.lines
      .filter((l) => l.isDebit)
      .reduce((sum, l) => sum + Number(l.amount), 0);

    // Heuristic JournalEntry ↔ Expense match: same vendor (case-insensitive),
    // same headline amount, same UTC day. No FK exists to do better yet.
    const matched =
      parsed.vendor === null
        ? undefined
        : expenses.find(
            (candidate) =>
              candidate.vendor.name.trim().toLowerCase() === parsed.vendor!.trim().toLowerCase() &&
              Number(candidate.amount) === debitTotal &&
              sameUtcDay(candidate.date, entry.date),
          );

    const makerIdentity = entry.makerIdentity ?? entry.createdBy;

    return {
      id: entry.id,
      date: entry.date.toISOString(),
      memo: entry.memo,
      makerIdentity,
      source: entry.source,
      sourceId: entry.sourceId,
      agentConfidence: entry.agentConfidence,
      amount: debitTotal.toFixed(2),
      lines: entry.lines.map((l) => ({
        accountName: l.account.name,
        accountCode: l.account.code,
        amount: l.amount.toString(),
        isDebit: l.isDebit,
      })),
      parsed,
      expense: matched
        ? {
            id: matched.id,
            vendorName: matched.vendor.name,
            categoryName: matched.expenseCategory.name,
            propertyName: matched.property.name,
            amount: matched.amount.toString(),
            date: matched.date.toISOString(),
            description: matched.description,
            confidenceScore: matched.confidenceScore,
            receiptCloudId: matched.receiptCloudId,
          }
        : null,
      evidence: evidenceByEntry.get(entry.id) ?? [],
      isOwnDraft: isSameIdentity(makerIdentity, userId),
    };
  });

  return { items };
}
