/**
 * RAJ-294 [P1-12] — 4-Eyes: No Self-Approval Enforcement (pure rules).
 *
 * The approver of a queued action (or a DRAFT journal entry) must be a
 * different identity than the maker. This must hold even for OWNER role —
 * role is deliberately NOT an input to these functions, so no caller can
 * carve out an exemption. Comparison is case- and whitespace-insensitive
 * ("Alice " and "alice" are the same human). A missing maker does not waive
 * the rule: the approver must still be a distinct, non-empty identity.
 */
import { describe, it, expect } from 'vitest';
import {
  assertNotSelfApproval,
  resolveIntentDecision,
  resolveDraftJournalDecision,
  SelfApprovalError,
  InvalidApprovalStateError,
} from '../../src/lib/approval.service';

describe('assertNotSelfApproval', () => {
  it('throws SelfApprovalError when maker and approver are the same identity', () => {
    expect(() => assertNotSelfApproval('user-1', 'user-1')).toThrow(SelfApprovalError);
  });

  it('is case-insensitive: "Alice" cannot approve what "alice" made', () => {
    expect(() => assertNotSelfApproval('Alice', 'alice')).toThrow(SelfApprovalError);
  });

  it('is whitespace-insensitive: " alice " cannot approve what "alice" made', () => {
    expect(() => assertNotSelfApproval('alice', ' alice ')).toThrow(SelfApprovalError);
  });

  it('passes when maker and approver are distinct identities', () => {
    expect(() => assertNotSelfApproval('user-1', 'user-2')).not.toThrow();
  });

  it('null maker still requires a non-empty approver', () => {
    expect(() => assertNotSelfApproval(null, '')).toThrow(SelfApprovalError);
    expect(() => assertNotSelfApproval(null, '   ')).toThrow(SelfApprovalError);
    expect(() => assertNotSelfApproval(null, undefined)).toThrow(SelfApprovalError);
    expect(() => assertNotSelfApproval(null, 'user-2')).not.toThrow();
  });

  it('undefined maker still requires a non-empty approver', () => {
    expect(() => assertNotSelfApproval(undefined, '')).toThrow(SelfApprovalError);
    expect(() => assertNotSelfApproval(undefined, 'user-2')).not.toThrow();
  });

  it('non-null maker with empty approver throws', () => {
    expect(() => assertNotSelfApproval('user-1', '')).toThrow(SelfApprovalError);
    expect(() => assertNotSelfApproval('user-1', undefined)).toThrow(SelfApprovalError);
  });
});

describe('resolveIntentDecision (ActionIntentQueue: PENDING → APPROVED | REJECTED)', () => {
  it('PENDING + APPROVE → APPROVED', () => {
    expect(resolveIntentDecision('PENDING', 'APPROVE')).toBe('APPROVED');
  });

  it('PENDING + REJECT → REJECTED', () => {
    expect(resolveIntentDecision('PENDING', 'REJECT')).toBe('REJECTED');
  });

  it.each(['APPROVED', 'REJECTED', 'EXECUTED', ''])(
    'throws InvalidApprovalStateError from non-PENDING status %j',
    (status) => {
      expect(() => resolveIntentDecision(status, 'APPROVE')).toThrow(InvalidApprovalStateError);
      expect(() => resolveIntentDecision(status, 'REJECT')).toThrow(InvalidApprovalStateError);
    },
  );
});

describe('resolveDraftJournalDecision (JournalEntry: DRAFT → POSTED | VOIDED)', () => {
  it('DRAFT + APPROVE → POSTED', () => {
    expect(resolveDraftJournalDecision('DRAFT', 'APPROVE')).toBe('POSTED');
  });

  it('DRAFT + REJECT → VOIDED', () => {
    expect(resolveDraftJournalDecision('DRAFT', 'REJECT')).toBe('VOIDED');
  });

  it.each(['POSTED', 'VOIDED', ''])(
    'throws InvalidApprovalStateError from non-DRAFT status %j',
    (status) => {
      expect(() => resolveDraftJournalDecision(status, 'APPROVE')).toThrow(InvalidApprovalStateError);
      expect(() => resolveDraftJournalDecision(status, 'REJECT')).toThrow(InvalidApprovalStateError);
    },
  );
});
