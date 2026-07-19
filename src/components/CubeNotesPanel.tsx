'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  createCubeNote,
  resolveCubeNote,
  verifyCubeNote,
  type CubeNoteResult,
} from '@/app/actions/cube-note.actions';
import { CUBE_NOTE_TAGS, type CubeNoteTag } from '@/lib/cube-note.service';

interface CubeNoteView {
  id: string;
  content: string;
  tag: string;
  period: string | null;
  uploadBatchId: string | null;
  linkedRef: string | null;
  resolved: boolean;
  authorIdentity: string;
  checkerIdentity: string | null;
  verifiedAt: string | Date | null;
  createdAt: string | Date;
}

interface CubeNotesPanelProps {
  notes: CubeNoteView[];
  periods: string[];
}

const TAG_LABEL: Record<string, string> = {
  BAD_DEBTOR: 'Bad debtor',
  UPLOAD_FLAG: 'Upload flag',
  QUERY: 'Query',
  MINUTE: 'Minute',
};

const inputStyle: React.CSSProperties = {
  padding: '0.625rem 0.75rem',
  borderRadius: '8px',
  background: 'var(--surface-color)',
  border: '1px solid var(--surface-border)',
  color: 'var(--text-primary)',
  fontSize: '0.875rem',
  width: '100%',
};

const btnStyle: React.CSSProperties = {
  padding: '0.5rem 1rem',
  borderRadius: '8px',
  fontWeight: 600,
  fontSize: '0.8125rem',
  cursor: 'pointer',
  border: '1px solid var(--surface-border)',
  background: 'var(--surface-color)',
  color: 'var(--text-primary)',
};

const formatDateTime = (date: string | Date | null) =>
  date ? new Intl.DateTimeFormat('en-IE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date)) : '—';

export default function CubeNotesPanel({ notes, periods }: CubeNotesPanelProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // New note form state
  const [content, setContent] = useState('');
  const [tag, setTag] = useState<CubeNoteTag>('MINUTE');
  const [period, setPeriod] = useState('');
  const [uploadBatchId, setUploadBatchId] = useState('');
  const [linkedRef, setLinkedRef] = useState('');

  // Filter state (client-side over the provided notes)
  const [filterTag, setFilterTag] = useState('');
  const [filterPeriod, setFilterPeriod] = useState('');
  const [filterResolved, setFilterResolved] = useState('');

  const filtered = useMemo(
    () =>
      notes.filter((n) => {
        if (filterTag && n.tag !== filterTag) return false;
        if (filterPeriod && n.period !== filterPeriod) return false;
        if (filterResolved === 'open' && n.resolved) return false;
        if (filterResolved === 'resolved' && !n.resolved) return false;
        return true;
      }),
    [notes, filterTag, filterPeriod, filterResolved],
  );

  const run = (fn: () => Promise<CubeNoteResult>, onOk?: () => void) => {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.success) {
        setError(result.error);
      } else {
        onOk?.();
        router.refresh();
      }
    });
  };

  const submit = () =>
    run(
      () => createCubeNote({ content, tag, period, uploadBatchId, linkedRef }),
      () => {
        setContent('');
        setPeriod('');
        setUploadBatchId('');
        setLinkedRef('');
      },
    );

  return (
    <div>
      {/* Add note */}
      <div className="glass-card" style={{ marginBottom: '1.5rem' }}>
        <h3 style={{ marginTop: 0, marginBottom: '1rem', fontSize: '1rem' }}>Add note / minute</h3>
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <label style={{ display: 'block' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Content</span>
            <textarea
              aria-label="Note content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={3}
              style={{ ...inputStyle, resize: 'vertical' }}
              placeholder="Bookkeeping minute, bad-debtor flag, query, or upload flag…"
            />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem' }}>
            <label>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Tag</span>
              <select aria-label="Note tag" value={tag} onChange={(e) => setTag(e.target.value as CubeNoteTag)} style={inputStyle}>
                {CUBE_NOTE_TAGS.map((t) => (
                  <option key={t} value={t}>
                    {TAG_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Period (YYYY-MM)</span>
              <input aria-label="Note period" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-07" style={inputStyle} />
            </label>
            <label>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Upload batch id</span>
              <input aria-label="Upload batch id" value={uploadBatchId} onChange={(e) => setUploadBatchId(e.target.value)} placeholder="for UPLOAD_FLAG" style={inputStyle} />
            </label>
            <label>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Linked ref</span>
              <input aria-label="Linked ref" value={linkedRef} onChange={(e) => setLinkedRef(e.target.value)} placeholder="cube row / ledger ref" style={inputStyle} />
            </label>
          </div>
          <div>
            <button type="button" onClick={submit} disabled={isPending || content.trim() === ''} style={{ ...btnStyle, background: 'var(--accent-color)', color: '#fff', borderColor: 'transparent', opacity: isPending ? 0.6 : 1 }}>
              {isPending ? 'Saving…' : 'Add note'}
            </button>
          </div>
          {error && (
            <div role="alert" style={{ fontSize: '0.8125rem', color: 'var(--danger-color)' }}>
              {error}
            </div>
          )}
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <select aria-label="Filter by tag" value={filterTag} onChange={(e) => setFilterTag(e.target.value)} style={{ ...inputStyle, width: 'auto' }}>
          <option value="">All tags</option>
          {CUBE_NOTE_TAGS.map((t) => (
            <option key={t} value={t}>
              {TAG_LABEL[t]}
            </option>
          ))}
        </select>
        <select aria-label="Filter by period" value={filterPeriod} onChange={(e) => setFilterPeriod(e.target.value)} style={{ ...inputStyle, width: 'auto' }}>
          <option value="">All periods</option>
          {periods.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select aria-label="Filter by status" value={filterResolved} onChange={(e) => setFilterResolved(e.target.value)} style={{ ...inputStyle, width: 'auto' }}>
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
        </select>
      </div>

      {/* Notes table */}
      <div className="glass-card">
        <table className="premium-table">
          <thead>
            <tr>
              <th>Created</th>
              <th>Tag</th>
              <th>Content</th>
              <th>Period</th>
              <th>Author</th>
              <th>Checker</th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
                  No notes yet. Add a minute, bad-debtor flag, query, or upload flag above.
                </td>
              </tr>
            ) : (
              filtered.map((n) => (
                <tr key={n.id}>
                  <td data-label="Created" style={{ padding: '1rem', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>{formatDateTime(n.createdAt)}</td>
                  <td data-label="Tag" style={{ padding: '1rem', fontWeight: 600 }}>{TAG_LABEL[n.tag] ?? n.tag}</td>
                  <td data-label="Content" style={{ padding: '1rem' }}>
                    <div>{n.content}</div>
                    {(n.uploadBatchId || n.linkedRef) && (
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                        {n.uploadBatchId ? `batch: ${n.uploadBatchId}` : ''} {n.linkedRef ? `ref: ${n.linkedRef}` : ''}
                      </div>
                    )}
                  </td>
                  <td data-label="Period" style={{ padding: '1rem', color: 'var(--text-secondary)' }}>{n.period ?? '—'}</td>
                  <td data-label="Author" style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>{n.authorIdentity}</td>
                  <td data-label="Checker" style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                    {n.verifiedAt ? `${n.checkerIdentity} ✓` : '—'}
                  </td>
                  <td data-label="Actions" style={{ padding: '1rem', textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                      {!n.resolved && (
                        <button type="button" onClick={() => run(() => resolveCubeNote(n.id))} disabled={isPending} style={btnStyle}>
                          Resolve
                        </button>
                      )}
                      {n.resolved && <span style={{ fontSize: '0.75rem', color: 'var(--success-color)' }}>Resolved</span>}
                      {!n.verifiedAt && (
                        <button type="button" onClick={() => run(() => verifyCubeNote(n.id))} disabled={isPending} style={{ ...btnStyle, borderColor: 'rgba(34,197,94,0.4)', color: 'var(--success-color)' }}>
                          Verify
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
