/**
 * RAJ-292 / RAJ-294 — 4-eyes approval rules (pure, no IO).
 *
 * These functions are the single authority for "may this identity decide
 * this item". Role is deliberately NOT an input: an OWNER who made an item
 * still cannot approve it, and no caller can add a role-based carve-out
 * without changing this file (and its tests).
 */

/** Thrown when the approver is the maker — or is not a usable identity at all. */
export class SelfApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelfApprovalError';
  }
}

/** Thrown when a decision is attempted from a status that is not decidable. */
export class InvalidApprovalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidApprovalStateError';
  }
}

export type ApprovalDecision = 'APPROVE' | 'REJECT';

/**
 * Case- and whitespace-insensitive identity normalisation: "Alice " and
 * "alice" are the same human as far as 4-eyes is concerned.
 */
function normalizeIdentity(identity: string | null | undefined): string {
  return (identity ?? '').trim().toLowerCase();
}

/**
 * RAJ-294 — the approver must be a distinct, non-empty identity.
 *
 * A null/undefined maker (legacy rows, system-generated items) does NOT
 * waive the rule: the approver must still be a real identity, so an
 * anonymous request can never slip a decision through.
 */
export function assertNotSelfApproval(
  makerIdentity: string | null | undefined,
  approverIdentity: string | null | undefined,
): void {
  const approver = normalizeIdentity(approverIdentity);
  if (approver === '') {
    throw new SelfApprovalError('Approver identity is missing. 4-eyes approval requires a signed-in, distinct approver.');
  }
  const maker = normalizeIdentity(makerIdentity);
  if (maker !== '' && maker === approver) {
    throw new SelfApprovalError('Self-approval is not allowed: the approver must be a different user than the maker (4-eyes).');
  }
}

/**
 * True when two identities are the same human under the normalisation
 * assertNotSelfApproval uses. UI-facing (flagging "your own draft" rows);
 * assertNotSelfApproval stays the enforcement authority.
 */
export function isSameIdentity(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = normalizeIdentity(a);
  return left !== '' && left === normalizeIdentity(b);
}

/**
 * ActionIntentQueue state machine: decisions are valid only from PENDING.
 * APPROVED / REJECTED / EXECUTED items are terminal for this workflow.
 */
export function resolveIntentDecision(
  currentStatus: string,
  decision: ApprovalDecision,
): 'APPROVED' | 'REJECTED' {
  if (currentStatus !== 'PENDING') {
    throw new InvalidApprovalStateError(
      `Cannot ${decision.toLowerCase()} an intent with status "${currentStatus}". Only PENDING items can be decided.`,
    );
  }
  return decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
}

/**
 * DRAFT JournalEntry promotion (RevenueService parks >€10k entries as DRAFT):
 * approve → POSTED, reject → VOIDED. Valid only from DRAFT.
 */
export function resolveDraftJournalDecision(
  currentStatus: string,
  decision: ApprovalDecision,
): 'POSTED' | 'VOIDED' {
  if (currentStatus !== 'DRAFT') {
    throw new InvalidApprovalStateError(
      `Cannot ${decision.toLowerCase()} a journal entry with status "${currentStatus}". Only DRAFT entries can be decided.`,
    );
  }
  return decision === 'APPROVE' ? 'POSTED' : 'VOIDED';
}
