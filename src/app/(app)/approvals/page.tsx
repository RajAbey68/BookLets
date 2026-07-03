import {
  fetchPendingActionIntents,
  fetchDraftJournalEntries,
  fetchRecentDecisions,
} from '@/app/actions/approval.actions';
import ApprovalDecisionButtons from '@/components/ApprovalDecisionButtons';

// Reads from the database; cannot be rendered at build time.
export const dynamic = 'force-dynamic';

type IntentItem = Awaited<ReturnType<typeof fetchPendingActionIntents>>[number];
type DraftEntry = Awaited<ReturnType<typeof fetchDraftJournalEntries>>[number];
type Decision = Awaited<ReturnType<typeof fetchRecentDecisions>>[number];

const formatDateTime = (date: Date | string) =>
  new Intl.DateTimeFormat('en-IE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));

const formatDate = (date: Date | string) =>
  new Intl.DateTimeFormat('en-IE', { dateStyle: 'medium' }).format(new Date(date));

const formatCurrency = (amount: number | { toString(): string }) =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(Number(amount));

/** Total debit side of a balanced entry = the entry's headline amount. */
const entryAmount = (entry: DraftEntry) =>
  entry.lines.filter((l) => l.isDebit).reduce((sum, l) => sum + Number(l.amount), 0);

const DECISION_LABELS: Record<string, { label: string; color: string }> = {
  ACTION_INTENT_APPROVED: { label: 'Intent approved', color: 'var(--success-color)' },
  ACTION_INTENT_REJECTED: { label: 'Intent rejected', color: 'var(--danger-color)' },
  JOURNAL_DRAFT_APPROVED: { label: 'Draft posted', color: 'var(--success-color)' },
  JOURNAL_DRAFT_REJECTED: { label: 'Draft voided', color: 'var(--danger-color)' },
};

export default async function ApprovalsPage() {
  const [intents, drafts, decisions] = await Promise.all([
    fetchPendingActionIntents(),
    fetchDraftJournalEntries(),
    fetchRecentDecisions(),
  ]);

  return (
    <>
      <div style={{ marginBottom: '2.5rem' }}>
        <div style={{ fontSize: '0.875rem', color: 'var(--accent-color)', fontWeight: '600', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Governance
        </div>
        <h1 style={{ marginBottom: '0.5rem' }}>Approvals</h1>
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
          4-eyes queue — items must be approved by a different user than the one who made them.
        </p>
      </div>

      {/* ── Pending agent actions (ActionIntentQueue) ── */}
      <h2 style={{ fontSize: '1.125rem', marginBottom: '1rem' }}>
        Pending agent actions
        <span style={{ marginLeft: '0.5rem', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>({intents.length})</span>
      </h2>
      <div className="glass-card" style={{ marginBottom: '2.5rem' }}>
        <table className="premium-table">
          <thead>
            <tr>
              <th>Queued</th>
              <th>Action</th>
              <th>Maker</th>
              <th style={{ textAlign: 'right' }}>Confidence</th>
              <th style={{ textAlign: 'right' }}>Decision</th>
            </tr>
          </thead>
          <tbody>
            {intents.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
                  No pending agent actions. Automated actions needing review will appear here.
                </td>
              </tr>
            ) : (
              intents.map((intent: IntentItem) => (
                <tr key={intent.id}>
                  <td data-label="Queued" style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                    {formatDateTime(intent.createdAt)}
                  </td>
                  <td data-label="Action" style={{ padding: '1rem' }}>
                    <div style={{ fontWeight: 600 }}>{intent.action}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
                      {JSON.stringify(intent.payload)}
                    </div>
                  </td>
                  <td data-label="Maker" style={{ padding: '1rem', color: 'var(--text-secondary)' }}>
                    {intent.makerIdentity}
                  </td>
                  <td data-label="Confidence" style={{ padding: '1rem', textAlign: 'right', fontWeight: 600 }}>
                    {(intent.confidence * 100).toFixed(0)}%
                  </td>
                  <td data-label="Decision" style={{ padding: '1rem' }}>
                    <ApprovalDecisionButtons kind="intent" itemId={intent.id} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── Draft journal entries (>€10k auto-parked by RevenueService) ── */}
      <h2 style={{ fontSize: '1.125rem', marginBottom: '1rem' }}>
        Draft journal entries awaiting posting
        <span style={{ marginLeft: '0.5rem', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>({drafts.length})</span>
      </h2>
      <div className="glass-card" style={{ marginBottom: '2.5rem' }}>
        <table className="premium-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Memo</th>
              <th>Maker</th>
              <th style={{ textAlign: 'right' }}>Amount</th>
              <th style={{ textAlign: 'right' }}>Decision</th>
            </tr>
          </thead>
          <tbody>
            {drafts.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
                  No draft entries waiting. High-value entries (over €10,000) land here for review before posting.
                </td>
              </tr>
            ) : (
              drafts.map((entry: DraftEntry) => (
                <tr key={entry.id}>
                  <td data-label="Date" style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                    {formatDate(entry.date)}
                  </td>
                  <td data-label="Memo" style={{ padding: '1rem' }}>
                    <div style={{ fontWeight: 500 }}>{entry.memo || '—'}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {entry.lines.map((l) => `${l.isDebit ? 'DR' : 'CR'} ${l.account.name}`).join(' · ')}
                    </div>
                  </td>
                  <td data-label="Maker" style={{ padding: '1rem', color: 'var(--text-secondary)' }}>
                    {entry.makerIdentity ?? entry.createdBy ?? '—'}
                  </td>
                  <td data-label="Amount" style={{ padding: '1rem', textAlign: 'right', fontWeight: 'bold' }}>
                    {formatCurrency(entryAmount(entry))}
                  </td>
                  <td data-label="Decision" style={{ padding: '1rem' }}>
                    <ApprovalDecisionButtons kind="journal" itemId={entry.id} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── Audit trail — recent decisions from the EvidenceLog ── */}
      <h2 style={{ fontSize: '1.125rem', marginBottom: '1rem' }}>Recent decisions (audit trail)</h2>
      <div className="glass-card">
        <table className="premium-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Decision</th>
              <th>Maker</th>
              <th>Checker</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {decisions.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
                  No decisions recorded yet.
                </td>
              </tr>
            ) : (
              decisions.map((decision: Decision) => {
                const meta = DECISION_LABELS[decision.eventType] ?? {
                  label: decision.eventType,
                  color: 'var(--text-secondary)',
                };
                return (
                  <tr key={decision.id}>
                    <td data-label="When" style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                      {formatDateTime(decision.createdAt)}
                    </td>
                    <td data-label="Decision" style={{ padding: '1rem', fontWeight: 600, color: meta.color }}>
                      {meta.label}
                    </td>
                    <td data-label="Maker" style={{ padding: '1rem', color: 'var(--text-secondary)' }}>
                      {decision.makerIdentity}
                    </td>
                    <td data-label="Checker" style={{ padding: '1rem', color: 'var(--text-secondary)' }}>
                      {decision.checkerIdentity ?? '—'}
                    </td>
                    <td data-label="Description" style={{ padding: '1rem', color: 'var(--text-secondary)' }}>
                      {decision.description}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
