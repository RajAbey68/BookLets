import Link from 'next/link';
import { fetchDraftReviewQueue } from '@/app/actions/approval.actions';
import DraftReviewQueue from '@/components/DraftReviewQueue';

// Reads from the database; cannot be rendered at build time.
export const dynamic = 'force-dynamic';

/**
 * S6 — /review: the DRAFT journal-entry review queue as a dedicated page.
 *
 * Auth is enforced by the global middleware (everything except /login is
 * gated) and the data layer is org-scoped via resolveActiveContext inside
 * fetchDraftReviewQueue. All decisions run through the existing 4-eyes
 * server actions (decideDraftJournalEntry / batchDecideDraftJournalEntries):
 * the checker is the session user, self-approval is rejected per entry, and
 * batch failures are isolated per row.
 */
export default async function ReviewPage() {
  const { items } = await fetchDraftReviewQueue();

  return (
    <>
      <div style={{ marginBottom: '2.5rem' }}>
        <div style={{ fontSize: '0.875rem', color: 'var(--accent-color)', fontWeight: '600', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Governance
        </div>
        <h1 style={{ marginBottom: '0.5rem' }}>Review</h1>
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
          Draft journal entries awaiting a 4-eyes decision — approve to post, reject to void.
          Entries you made yourself must be decided by a different checker.
        </p>
      </div>

      <h2 style={{ fontSize: '1.125rem', marginBottom: '1rem' }}>
        Drafts awaiting decision
        <span style={{ marginLeft: '0.5rem', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
          ({items.length}{items.length === 100 ? ' — newest 100 shown; decide some to surface older drafts' : ''})
        </span>
      </h2>
      <DraftReviewQueue items={items} />

      <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
        Pending agent actions and the decision audit trail live on{' '}
        <Link href="/approvals" style={{ color: 'var(--accent-color)' }}>Approvals</Link>.
      </p>
    </>
  );
}
