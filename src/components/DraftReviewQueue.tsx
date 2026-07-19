'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  batchDecideDraftJournalEntries,
  type BatchDecisionResult,
  type DraftReviewItem,
} from '@/app/actions/approval.actions';
import ApprovalDecisionButtons from '@/components/ApprovalDecisionButtons';
import DraftEditForm from '@/components/DraftEditForm';

interface DraftReviewQueueProps {
  items: DraftReviewItem[];
}

const formatDate = (iso: string) =>
  new Intl.DateTimeFormat('en-IE', { dateStyle: 'medium' }).format(new Date(iso));

const formatDateTime = (iso: string) =>
  new Intl.DateTimeFormat('en-IE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

const formatCurrency = (amount: string) =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(Number(amount));

const ORIGIN_LABELS: Record<DraftReviewItem['parsed']['origin'], string> = {
  'receipt-automation': 'Receipt OCR',
  'zip-ingest': 'ZIP ingest',
  manual: 'Manual / system',
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: '0.6875rem',
  color: 'var(--text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  fontWeight: 600,
};

const columnHeadingStyle: React.CSSProperties = {
  ...fieldLabelStyle,
  marginBottom: '0.75rem',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={fieldLabelStyle}>{label}</div>
      <div style={{ fontSize: '0.875rem' }}>{children}</div>
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: number | null }) {
  if (confidence === null) return <span style={{ color: 'var(--text-secondary)' }}>—</span>;
  const pct = `${(confidence * 100).toFixed(0)}%`;
  return (
    <span className={confidence > 0.9 ? 'badge badge-success' : 'badge badge-warning'}>
      {pct} confidence
    </span>
  );
}

/**
 * S6 — DRAFT review queue: each automated entry with its evidence
 * side-by-side, plus batch approve/reject over a checkbox selection.
 *
 * The checkboxes only carry entry ids; the checker identity is resolved
 * server-side from the session and every entry in the batch passes through
 * the same per-entry 4-eyes pipeline (batchDecideDraftJournalEntries).
 * Entries the signed-in user made are not selectable here, and the server
 * excludes them with a per-entry error even if this guard is bypassed.
 */
export default function DraftReviewQueue({ items }: DraftReviewQueueProps) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [batchError, setBatchError] = useState<string | null>(null);
  const [entryErrors, setEntryErrors] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const eligibleIds = useMemo(
    () => items.filter((item) => !item.isOwnDraft).map((item) => item.id),
    [items],
  );

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const decideSelected = (decision: 'APPROVE' | 'REJECT') => {
    setBatchError(null);
    setSummary(null);
    setEntryErrors({});
    const ids = [...selected];
    startTransition(async () => {
      const result: BatchDecisionResult = await batchDecideDraftJournalEntries(ids, decision);
      if (!result.ok) {
        setBatchError(result.error);
        return;
      }
      const failures: Record<string, string> = {};
      for (const entry of result.results) {
        if (!entry.success) failures[entry.entryId] = entry.error ?? 'Decision failed.';
      }
      setEntryErrors(failures);
      const verb = decision === 'APPROVE' ? 'approved' : 'rejected';
      setSummary(
        result.failed === 0
          ? `${result.succeeded} ${result.succeeded === 1 ? 'entry' : 'entries'} ${verb}.`
          : `${result.succeeded} ${verb}, ${result.failed} failed — see the flagged entries below.`,
      );
      // Keep only the failed ids selected so the checker can retry or inspect.
      setSelected(new Set(Object.keys(failures)));
      router.refresh();
    });
  };

  if (items.length === 0) {
    return (
      <div className="glass-card" style={{ marginBottom: '2.5rem', textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
        No draft entries waiting. Automated entries (receipt OCR, ZIP ingest) and high-value
        entries land here for 4-eyes review before posting.
      </div>
    );
  }

  return (
    <div style={{ marginBottom: '2.5rem' }}>
      {/* ── Batch action bar ── */}
      <div
        className="glass-card"
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem', padding: '1rem 1.5rem', marginBottom: '1rem' }}
      >
        <span style={{ fontSize: '0.875rem', fontWeight: 600 }}>
          {selected.size} of {eligibleIds.length} selectable draft{eligibleIds.length === 1 ? '' : 's'} selected
        </span>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ padding: '0.5rem 0.875rem', fontSize: '0.8125rem' }}
          onClick={() => setSelected(new Set(eligibleIds))}
          disabled={isPending || eligibleIds.length === 0}
        >
          Select all
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ padding: '0.5rem 0.875rem', fontSize: '0.8125rem' }}
          onClick={() => setSelected(new Set())}
          disabled={isPending || selected.size === 0}
        >
          Clear
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
          <button
            type="button"
            className="btn btn-primary"
            style={{ padding: '0.5rem 1rem', fontSize: '0.8125rem' }}
            onClick={() => decideSelected('APPROVE')}
            disabled={isPending || selected.size === 0}
          >
            {isPending ? 'Working…' : `Approve selected (${selected.size})`}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ padding: '0.5rem 1rem', fontSize: '0.8125rem', color: 'var(--danger-color)', borderColor: 'rgba(244, 63, 94, 0.4)' }}
            onClick={() => decideSelected('REJECT')}
            disabled={isPending || selected.size === 0}
          >
            Reject selected
          </button>
        </div>
        {batchError && (
          <div role="alert" style={{ flexBasis: '100%', fontSize: '0.8125rem', color: 'var(--danger-color)' }}>
            {batchError}
          </div>
        )}
        {summary && (
          <div role="status" style={{ flexBasis: '100%', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
            {summary}
          </div>
        )}
      </div>

      {/* ── One card per DRAFT: evidence side-by-side ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {items.map((item) => {
          const entryError = entryErrors[item.id];
          const checked = selected.has(item.id);
          return (
            <div
              key={item.id}
              className="glass-card"
              style={{
                borderColor: entryError
                  ? 'var(--danger-color)'
                  : checked
                    ? 'var(--accent-color)'
                    : undefined,
              }}
            >
              {/* Card header: selection + identity + per-entry decision */}
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '1rem', marginBottom: '1.25rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', cursor: item.isOwnDraft ? 'not-allowed' : 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={item.isOwnDraft || isPending}
                    onChange={() => toggle(item.id)}
                    aria-label={`Select draft ${item.memo ?? item.id} for batch decision`}
                    style={{ width: '1.125rem', height: '1.125rem', accentColor: 'var(--accent-color)' }}
                  />
                  <span style={{ fontWeight: 600, fontSize: '0.9375rem' }}>{item.memo || 'Untitled draft entry'}</span>
                </label>
                <span className="badge" style={{ background: 'rgba(59, 130, 246, 0.1)', color: 'var(--accent-hover)' }}>
                  {ORIGIN_LABELS[item.parsed.origin]}
                </span>
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ padding: '0.375rem 0.75rem', fontSize: '0.75rem' }}
                    onClick={() => setEditingId(editingId === item.id ? null : item.id)}
                    disabled={isPending}
                  >
                    {editingId === item.id ? 'Close editor' : 'Edit'}
                  </button>
                  {item.isOwnDraft ? (
                    <span style={{ fontSize: '0.75rem', color: 'var(--warning-color)', fontWeight: 600 }}>
                      Your own draft — a different checker must decide it (4-eyes)
                    </span>
                  ) : (
                    <ApprovalDecisionButtons kind="journal" itemId={item.id} />
                  )}
                </div>
              </div>

              {editingId === item.id && (
                <DraftEditForm
                  entryId={item.id}
                  version={item.version}
                  initialMemo={item.memo ?? ''}
                  initialDate={item.date}
                  initialAmount={item.amount}
                  canEditAmount={
                    item.lines.length === 2 &&
                    item.lines[0].amount === item.lines[1].amount
                  }
                  onSaved={() => {
                    setEditingId(null);
                    router.refresh();
                  }}
                  onCancel={() => setEditingId(null)}
                />
              )}

              {entryError && (
                <div
                  role="alert"
                  style={{ marginBottom: '1rem', fontSize: '0.8125rem', color: 'var(--danger-color)', fontWeight: 600 }}
                >
                  Not decided: {entryError}
                </div>
              )}

              {/* Evidence, side-by-side */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1.5rem' }}>
                {/* 1 — Extracted fields */}
                <div>
                  <div style={columnHeadingStyle}>Extracted fields</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                    <Field label="Vendor">{item.parsed.vendor ?? '—'}</Field>
                    {item.parsed.category && <Field label="Category">{item.parsed.category}</Field>}
                    {item.parsed.fileName && <Field label="Source file">{item.parsed.fileName}</Field>}
                    <Field label="Amount">
                      <span style={{ fontWeight: 700 }}>{formatCurrency(item.amount)}</span>
                    </Field>
                    <Field label="Date">{formatDate(item.date)}</Field>
                    <Field label="Confidence">
                      <ConfidenceBadge confidence={item.agentConfidence} />
                    </Field>
                    <Field label="Maker">{item.makerIdentity ?? '—'}</Field>
                    {item.source && (
                      <Field label="Provenance">
                        {item.source}
                        {item.sourceId ? ` · ${item.sourceId.slice(0, 12)}…` : ''}
                      </Field>
                    )}
                  </div>
                </div>

                {/* 2 — Journal lines */}
                <div>
                  <div style={columnHeadingStyle}>Journal lines</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {item.lines.map((line, index) => (
                      <div
                        key={index}
                        style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', fontSize: '0.8125rem', borderBottom: '1px solid var(--surface-border)', paddingBottom: '0.375rem' }}
                      >
                        <span>
                          <span style={{ fontWeight: 600, color: line.isDebit ? 'var(--success-color)' : 'var(--accent-hover)' }}>
                            {line.isDebit ? 'DR' : 'CR'}
                          </span>{' '}
                          {line.accountName}
                          {line.accountCode ? (
                            <span style={{ color: 'var(--text-secondary)' }}> ({line.accountCode})</span>
                          ) : null}
                        </span>
                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(line.amount)}</span>
                      </div>
                    ))}
                  </div>
                  {item.evidence.length > 0 && (
                    <div style={{ marginTop: '1rem' }}>
                      <div style={columnHeadingStyle}>Audit trail</div>
                      {item.evidence.map((row) => (
                        <div key={row.id} style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.375rem' }}>
                          {formatDateTime(row.createdAt)} · {row.eventType} — {row.description}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 3 — Linked expense record */}
                <div>
                  <div style={columnHeadingStyle}>Expense record</div>
                  {item.expense ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                      <Field label="Vendor">{item.expense.vendorName}</Field>
                      <Field label="Category">{item.expense.categoryName}</Field>
                      <Field label="Property">{item.expense.propertyName}</Field>
                      <Field label="Amount">{formatCurrency(item.expense.amount)}</Field>
                      {item.expense.description && <Field label="Description">{item.expense.description}</Field>}
                      <Field label="OCR confidence">
                        <ConfidenceBadge confidence={item.expense.confidenceScore} />
                      </Field>
                      <div style={{ fontSize: '0.6875rem', color: 'var(--text-secondary)' }}>
                        Matched heuristically (vendor + amount + date) — journal entries carry no
                        expense link yet.
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                      No expense record matched this entry.
                    </div>
                  )}
                </div>

                {/* 4 — Receipt image (typed placeholder: images are not persisted) */}
                <div>
                  <div style={columnHeadingStyle}>Receipt image</div>
                  {item.expense?.receiptCloudId ? (
                    <div style={{ fontSize: '0.8125rem' }}>
                      Stored reference: <code>{item.expense.receiptCloudId}</code>
                      <div style={{ fontSize: '0.6875rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                        Viewer not wired yet — follow-up in AGENTS_LOG.md.
                      </div>
                    </div>
                  ) : (
                    <div
                      style={{
                        border: '1px dashed var(--surface-border)',
                        borderRadius: 'var(--border-radius)',
                        padding: '1.25rem',
                        fontSize: '0.75rem',
                        color: 'var(--text-secondary)',
                        textAlign: 'center',
                      }}
                    >
                      No stored image. Receipts are processed in-memory (OCR extraction only) and
                      the original file is discarded — image persistence is a tracked follow-up,
                      not part of this review UI.
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
