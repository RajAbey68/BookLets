import Link from 'next/link';
import { fetchDraftReviewQueue } from '@/app/actions/approval.actions';
import { fetchOcrStagingSummary } from '@/app/actions/sandbox.actions';
import DraftReviewQueue from '@/components/DraftReviewQueue';
import FeedIntoBooksButton from '@/components/FeedIntoBooksButton';
import SandboxBooksTabs from '@/components/SandboxBooksTabs';
import ZipUploadCard from '@/components/ZipUploadCard';
import { parkReasonLabel } from '@/lib/park-reason-labels';

// Reads from the database; cannot be rendered at build time.
export const dynamic = 'force-dynamic';

// Bounded like /review, but smaller: the sandbox shows the newest slice and
// links to /review for the full queue.
const SANDBOX_QUEUE_CAP = 25;

/**
 * S11 — /sandbox: everything BEFORE the books, on one page. Raj uploads a
 * receipts zip (drafts only), watches the staging pile, feeds staged OCR
 * receipts into the books (still drafts), and runs the consensus queue —
 * the exact same 4-eyes actions as /review, reused, not duplicated.
 */
export default async function SandboxPage() {
  const [staging, { items }] = await Promise.all([
    fetchOcrStagingSummary(),
    fetchDraftReviewQueue({ limit: SANDBOX_QUEUE_CAP }),
  ]);

  return (
    <>
      <div style={{ marginBottom: '1.5rem' }}>
        <div style={{ fontSize: '0.875rem', color: 'var(--accent-color)', fontWeight: '600', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Workspace
        </div>
        <h1 style={{ marginBottom: '0.5rem' }}>Sandbox</h1>
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
          Upload receipts, review what was read, and approve what goes into the books.
          Nothing here touches the books until it passes consensus.
        </p>
      </div>

      <SandboxBooksTabs active="sandbox" />

      {/* ── Upload + staging pile, side by side ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.5rem', marginBottom: '2.5rem' }}>
        <ZipUploadCard />

        <div className="glass-card">
          <h3 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>Staging pile</h3>
          {staging.available ? (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.875rem', marginBottom: '1.25rem' }}>
                <div>
                  <span style={{ fontWeight: 700 }}>{staging.importable}</span>{' '}
                  ready to feed into the books
                </div>
                {staging.parked.map((p) => (
                  <div key={p.reason} style={{ color: 'var(--text-secondary)' }}>
                    <span style={{ fontWeight: 600 }}>{p.count}</span> parked — {parkReasonLabel(p.reason)}
                  </div>
                ))}
                <div style={{ color: 'var(--text-secondary)' }}>
                  <span style={{ fontWeight: 600 }}>{staging.alreadyImported}</span> already imported
                </div>
                <div style={{ color: 'var(--text-secondary)', borderTop: '1px solid var(--surface-border)', paddingTop: '0.5rem' }}>
                  {staging.total} receipt{staging.total === 1 ? '' : 's'} staged in total
                </div>
              </div>
              <FeedIntoBooksButton />
            </>
          ) : (
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', margin: 0 }}>
              Staging unavailable — the OCR receipt staging area is not connected in this
              environment, so there is nothing to feed from here. Zip uploads above still work.
            </p>
          )}
        </div>
      </div>

      {/* ── Consensus queue: the SAME 4-eyes queue and actions as /review ── */}
      <h2 style={{ fontSize: '1.125rem', marginBottom: '1rem' }}>
        Consensus queue
        <span style={{ marginLeft: '0.5rem', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
          ({items.length}{items.length === SANDBOX_QUEUE_CAP ? ` — newest ${SANDBOX_QUEUE_CAP} shown` : ''})
        </span>
      </h2>
      <DraftReviewQueue items={items} />

      <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
        Approving posts an entry into the books; rejecting voids it. Entries you made yourself
        need a different checker. The full queue with evidence lives on{' '}
        <Link href="/review" style={{ color: 'var(--accent-color)' }}>Review</Link>.
      </p>
    </>
  );
}
