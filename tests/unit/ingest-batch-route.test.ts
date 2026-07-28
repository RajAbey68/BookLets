/**
 * POST /api/ingest/batch — closes one client-driven import run.
 *
 * The single-request zip path wrote one ZIP_INGEST_COMPLETED evidence row per
 * archive. Now that the archive is uploaded item-by-item, that summary row is
 * rebuilt here — and the counts are recomputed SERVER-SIDE from the per-item
 * evidence rows, never taken from the client's tally, so the audit trail cannot
 * be talked into a number that did not happen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockResolveActiveContext = vi.fn();
vi.mock('@/lib/auth-context', () => ({
  resolveActiveContext: (...args: unknown[]) => mockResolveActiveContext(...args),
}));

const mockDeps = {
  loadBatchItemEvidence: vi.fn(async () => [
    { name: 'IMG-1.jpg', kind: 'image', outcome: 'created' },
    { name: 'IMG-2.jpg', kind: 'image', outcome: 'created' },
    { name: 'IMG-3.jpg', kind: 'image', outcome: 'duplicate' },
    { name: 'IMG-4.jpg', kind: 'image', outcome: 'failed', stage: 'ocr' },
    { name: 'voice.opus', kind: 'unknown', outcome: 'skipped' },
    { name: '_chat.txt', kind: 'text', outcome: 'created' },
  ]),
  recordEvidence: vi.fn(async () => {}),
};
vi.mock('@/lib/ingest-item.deps', () => ({
  buildDefaultBatchSummaryDeps: () => mockDeps,
  buildDefaultItemIngestDeps: () => ({}),
  itemRateLimiter: { tryConsume: () => true, reset: () => {} },
}));

import { POST } from '../../src/app/api/ingest/batch/route';
import { tallyBatch } from '../../src/lib/ingest-item';

const AUTHED = {
  ok: true as const,
  context: {
    organizationId: 'org_test_1',
    organizationName: 'Test Org',
    userId: 'user_test_1',
    role: 'OWNER',
  },
};

const BATCH_ID = '4b1e2c3d-0000-4000-8000-000000000001';

function batchRequest(body: unknown): Request {
  return new Request('http://localhost/api/ingest/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveActiveContext.mockResolvedValue(AUTHED);
});

describe('tallyBatch', () => {
  it('counts each outcome exactly once', () => {
    const tally = tallyBatch([
      { name: 'a', kind: 'image', outcome: 'created' },
      { name: 'b', kind: 'image', outcome: 'duplicate' },
      { name: 'c', kind: 'image', outcome: 'failed', stage: 'ocr' },
      { name: 'd', kind: 'unknown', outcome: 'skipped' },
      { name: 'e', kind: 'text', outcome: 'created' },
    ]);
    expect(tally).toEqual({ total: 5, created: 1, deduped: 1, failed: 1, skipped: 1, chatFiles: 1 });
  });
});

describe('POST /api/ingest/batch', () => {
  it('401s an unauthenticated request', async () => {
    mockResolveActiveContext.mockResolvedValue({ ok: false, error: 'Not authenticated.' });
    const res = await POST(batchRequest({ batchId: BATCH_ID }));
    expect(res.status).toBe(401);
    expect(mockDeps.recordEvidence).not.toHaveBeenCalled();
  });

  it('400s a malformed batch id', async () => {
    const res = await POST(batchRequest({ batchId: 'nope\n<script>' }));
    expect(res.status).toBe(400);
    expect(mockDeps.recordEvidence).not.toHaveBeenCalled();
  });

  it('writes a completion row with SERVER-recounted totals, ignoring any client tally', async () => {
    const res = await POST(
      batchRequest({ batchId: BATCH_ID, archiveName: 'WhatsApp Chat.zip', created: 999 }),
    );
    expect(res.status).toBe(200);
    const evidence = (mockDeps.recordEvidence.mock.calls[0] as unknown[])[0] as {
      eventType: string;
      tenantId: string;
      payload: Record<string, unknown>;
    };
    expect(evidence.eventType).toBe('WHATSAPP_BATCH_COMPLETED');
    expect(evidence.tenantId).toBe('org_test_1');
    expect(evidence.payload.batchId).toBe(BATCH_ID);
    // Two image drafts. The chat transcript is evidence, not an entry, so it
    // is counted under chatFiles — never as an imported receipt.
    expect(evidence.payload.created).toBe(2);
    expect(evidence.payload.deduped).toBe(1);
    expect(evidence.payload.failed).toBe(1);
    expect(evidence.payload.skipped).toBe(1);
    expect(evidence.payload.chatFiles).toBe(1);
    expect(evidence.payload.created).not.toBe(999);
  });

  it('sanitises the client-supplied archive name before it reaches the audit trail', async () => {
    await POST(batchRequest({ batchId: BATCH_ID, archiveName: 'ev il\n.zip' }));
    const evidence = (mockDeps.recordEvidence.mock.calls[0] as unknown[])[0] as { payload: Record<string, unknown> };
    expect(String(evidence.payload.archiveName)).not.toMatch(/[ \n]/);
  });

  it('still answers 200 when the recount query fails — the drafts already landed', async () => {
    mockDeps.loadBatchItemEvidence.mockRejectedValueOnce(new Error('db down'));
    const res = await POST(batchRequest({ batchId: BATCH_ID }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summaryRecorded).toBe(false);
  });
});
