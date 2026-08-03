import { describe, it, expect } from 'vitest';
import { settledDecisionFromError } from '@/lib/approval-decision-label';

/**
 * Two approvers, one item. B rejects it; A — who has not refreshed — clicks
 * Approve. The server refuses, correctly, and the UI has to decide what to
 * show. Reflecting A's own attempt back tells them "Approved — posted to the
 * ledger" about an entry that was voided.
 *
 * These assertions are on the real message text produced by
 * approval.service.ts, not on a paraphrase of it, so a reworded error breaks
 * the test rather than silently reverting the label to the attempted decision.
 */
describe('settledDecisionFromError', () => {
  it('reads a journal entry that was already approved by someone else', () => {
    expect(
      settledDecisionFromError(
        'Cannot reject a journal entry with status "POSTED". Only DRAFT entries can be decided.',
      ),
    ).toBe('APPROVE');
  });

  it('reads a journal entry that was already rejected by someone else', () => {
    expect(
      settledDecisionFromError(
        'Cannot approve a journal entry with status "VOIDED". Only DRAFT entries can be decided.',
      ),
    ).toBe('REJECT');
  });

  it('reads an intent that was already approved, and one already executed', () => {
    expect(
      settledDecisionFromError(
        'Cannot reject an intent with status "APPROVED". Only PENDING items can be decided.',
      ),
    ).toBe('APPROVE');
    expect(
      settledDecisionFromError(
        'Cannot reject an intent with status "EXECUTED". Only PENDING items can be decided.',
      ),
    ).toBe('APPROVE');
  });

  it('reads an intent that was already rejected', () => {
    expect(
      settledDecisionFromError(
        'Cannot approve an intent with status "REJECTED". Only PENDING items can be decided.',
      ),
    ).toBe('REJECT');
  });

  it('takes the quoted status, not the attempted decision named in the prose', () => {
    // The bug this guards: "Cannot approve …" contains the word approve, so a
    // whole-string search returns the attempt and the label lies in exactly the
    // case it is meant to fix.
    expect(
      settledDecisionFromError(
        'Cannot approve an intent with status "REJECTED". Only PENDING items can be decided.',
      ),
    ).not.toBe('APPROVE');
  });

  it('returns null when there is no status to read, so the caller can fall back', () => {
    expect(settledDecisionFromError('Only DRAFT entries can be decided.')).toBeNull();
    expect(settledDecisionFromError('')).toBeNull();
    expect(
      settledDecisionFromError('Cannot approve an intent with status "SOMETHING_NEW".'),
    ).toBeNull();
  });
});
