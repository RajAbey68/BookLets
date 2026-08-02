'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { parkReasonLabel } from '@/lib/park-reason-labels';

/** The fields of OcrBridgeSummary (src/lib/ocr-bridge.ts) this button renders. */
interface BridgeSummary {
  posted: number;
  skipped_existing: number;
  failed: { id: number; error: string }[];
  parked: { reason: string; count: number; ids: number[] }[];
  parkedPermanently: number;
  remaining: number;
}

/**
 * S11 — "Feed into books": trigger one default-size batch of the S1b
 * staging→ledger bridge (POST /api/ingest/ocr-bridge with an empty JSON
 * object, meaning "use defaults"). Everything it creates is a DRAFT — the
 * consensus queue still decides what actually posts. The route's own gates
 * (401/403 role/org, 503 unconfigured) are surfaced verbatim where the
 * response provides a message.
 */
export default function FeedIntoBooksButton() {
  const [isRunning, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<BridgeSummary | null>(null);
  const router = useRouter();

  const run = async () => {
    setRunning(true);
    setError(null);
    setSummary(null);
    try {
      const res = await fetch('/api/ingest/ocr-bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      let body: (BridgeSummary & { error?: string }) | { error?: string } = {};
      try {
        body = await res.json();
      } catch {
        /* non-JSON body — fall through to the status-based messages */
      }

      if (!res.ok) {
        if (res.status === 401) setError('Sign in to feed receipts into the books.');
        else if (res.status === 403) setError(body.error ?? 'Your role can’t run the import.');
        else if (res.status === 503) setError(body.error ?? 'The staging bridge is not configured in this environment.');
        else setError(body.error ?? `Import failed (HTTP ${res.status}). Try again shortly.`);
        return;
      }

      setSummary(body as BridgeSummary);
      // Refresh the staging summary and consensus queue rendered server-side.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed. Check your connection and try again.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => void run()}
        disabled={isRunning}
        style={{ opacity: isRunning ? 0.6 : 1 }}
      >
        {isRunning ? 'Feeding into books…' : 'Feed into books'}
      </button>

      {error && (
        <div role="alert" style={{ marginTop: '0.75rem', fontSize: '0.8125rem', color: 'var(--danger-color)', fontWeight: 600 }}>
          {error}
        </div>
      )}

      {summary && (
        <div role="status" style={{ marginTop: '0.75rem', fontSize: '0.8125rem' }}>
          <div style={{ fontWeight: 600 }}>
            {summary.posted} receipt{summary.posted === 1 ? '' : 's'} moved into the books as drafts,{' '}
            {summary.skipped_existing} already there (skipped).
          </div>
          {summary.parked.map((p) => (
            <div key={p.reason} style={{ color: 'var(--text-secondary)' }}>
              {p.count} parked — {parkReasonLabel(p.reason)}.
            </div>
          ))}
          {summary.failed.length > 0 && (
            <div style={{ color: 'var(--danger-color)' }}>
              {summary.failed.length} receipt{summary.failed.length === 1 ? '' : 's'} failed to import — see server logs.
            </div>
          )}
          <div style={{ color: 'var(--text-secondary)' }}>
            {summary.remaining === 0
              ? 'Nothing importable is left in staging.'
              : `${summary.remaining} more receipt${summary.remaining === 1 ? '' : 's'} still waiting — press the button again.`}
          </div>
          {summary.posted > 0 && (
            <div style={{ color: 'var(--text-secondary)' }}>
              New drafts appear in the consensus queue below for approval.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
