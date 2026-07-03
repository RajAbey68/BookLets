'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  decideActionIntent,
  decideDraftJournalEntry,
  type DecisionResult,
} from '@/app/actions/approval.actions';

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
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const decide = (decision: 'APPROVE' | 'REJECT') => {
    setError(null);
    startTransition(async () => {
      const result: DecisionResult =
        kind === 'intent'
          ? await decideActionIntent(itemId, decision)
          : await decideDraftJournalEntry(itemId, decision);
      if (!result.success) {
        setError(result.error);
      } else {
        router.refresh();
      }
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', alignItems: 'flex-end' }}>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          type="button"
          onClick={() => decide('APPROVE')}
          disabled={isPending}
          style={{
            ...buttonBase,
            background: 'rgba(34, 197, 94, 0.12)',
            borderColor: 'rgba(34, 197, 94, 0.4)',
            color: 'var(--success-color)',
            opacity: isPending ? 0.6 : 1,
          }}
        >
          {isPending ? 'Working…' : 'Approve'}
        </button>
        <button
          type="button"
          onClick={() => decide('REJECT')}
          disabled={isPending}
          style={{
            ...buttonBase,
            background: 'rgba(239, 68, 68, 0.12)',
            borderColor: 'rgba(239, 68, 68, 0.4)',
            color: 'var(--danger-color)',
            opacity: isPending ? 0.6 : 1,
          }}
        >
          Reject
        </button>
      </div>
      {error && (
        <div role="alert" style={{ fontSize: '0.75rem', color: 'var(--danger-color)', maxWidth: '18rem', textAlign: 'right' }}>
          {error}
        </div>
      )}
    </div>
  );
}
