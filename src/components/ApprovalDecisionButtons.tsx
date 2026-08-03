'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  decideActionIntent,
  decideDraftJournalEntry,
  type DecisionResult,
} from '@/app/actions/approval.actions';
import { settledDecisionFromError } from '@/lib/approval-decision-label';

interface ApprovalDecisionButtonsProps {
  /** Which queue the item belongs to — routes to the matching server action. */
  kind: 'intent' | 'journal';
  itemId: string;
}

const buttonBase: React.CSSProperties = {
  padding: '0.5rem 1rem',
  borderRadius: '8px',
  fontWeight: 600,
  fontSize: '0.8125rem',
  cursor: 'pointer',
  border: '1px solid transparent',
};

/**
 * RAJ-292 — Approve / Reject controls for a pending 4-eyes item.
 *
 * The buttons only carry the item id + decision; the approver identity is
 * resolved server-side from the session, so nothing here is trusted input.
 * Server-side enforcement (no self-approval, PENDING/DRAFT-only) is the
 * authority — any error it returns is surfaced inline.
 */
export default function ApprovalDecisionButtons({ kind, itemId }: ApprovalDecisionButtonsProps) {
  const [error, setError] = useState<string | null>(null);
  const [decided, setDecided] = useState<'APPROVE' | 'REJECT' | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  /**
   * The server refuses a second decision — the write is a conditional update
   * (`where: { id, status: 'DRAFT' }`), so a decided item matches zero rows and
   * nothing is ever posted twice. But until `router.refresh()` finished
   * re-rendering the list, these buttons stayed live and clickable, so an item
   * already approved still *looked* actionable. Scrolling back up a long queue,
   * you could press Approve on the same row repeatedly with no visible
   * difference between "it worked" and "it did nothing".
   *
   * Deciding locally closes that window immediately, without waiting on a round
   * trip. Note this is presentation only: the authority is, and stays, the
   * conditional update on the server.
   */
  const decide = (decision: 'APPROVE' | 'REJECT') => {
    setError(null);
    startTransition(async () => {
      const result: DecisionResult =
        kind === 'intent'
          ? await decideActionIntent(itemId, decision)
          : await decideDraftJournalEntry(itemId, decision);
      if (!result.success) {
        // "Only DRAFT entries can be decided" is not a failure the operator
        // caused or can act on — it means someone (possibly them, a moment
        // ago) already decided this item. Show it as settled rather than as a
        // red error, which is alarming and suggests something needs fixing.
        if (/only (draft|pending)/i.test(result.error)) {
          // Show how it actually settled, not what this operator attempted.
          // Falls back to the attempt only when the status cannot be read —
          // router.refresh() below reconciles either way.
          setDecided(settledDecisionFromError(result.error) ?? decision);
          router.refresh();
        } else {
          setError(result.error);
        }
      } else {
        setDecided(decision);
        router.refresh();
      }
    });
  };

  const settled = decided !== null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', alignItems: 'flex-end' }}>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          type="button"
          onClick={() => decide('APPROVE')}
          disabled={isPending || settled}
          aria-disabled={isPending || settled}
          style={{
            ...buttonBase,
            background: 'rgba(34, 197, 94, 0.12)',
            borderColor: 'rgba(34, 197, 94, 0.4)',
            color: 'var(--success-color)',
            opacity: isPending || settled ? 0.45 : 1,
            cursor: settled ? 'default' : isPending ? 'wait' : 'pointer',
          }}
        >
          {decided === 'APPROVE' ? 'Approved' : isPending ? 'Working…' : 'Approve'}
        </button>
        <button
          type="button"
          onClick={() => decide('REJECT')}
          disabled={isPending || settled}
          aria-disabled={isPending || settled}
          style={{
            ...buttonBase,
            background: 'rgba(239, 68, 68, 0.12)',
            borderColor: 'rgba(239, 68, 68, 0.4)',
            color: 'var(--danger-color)',
            opacity: isPending || settled ? 0.45 : 1,
            cursor: settled ? 'default' : isPending ? 'wait' : 'pointer',
          }}
        >
          {decided === 'REJECT' ? 'Rejected' : 'Reject'}
        </button>
      </div>
      {settled && (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          {decided === 'APPROVE' ? 'Approved — posted to the ledger.' : 'Rejected — voided, nothing posted.'}
        </div>
      )}
      {error && (
        <div role="alert" style={{ fontSize: '0.75rem', color: 'var(--danger-color)', maxWidth: '18rem', textAlign: 'right' }}>
          {error}
        </div>
      )}
    </div>
  );
}
