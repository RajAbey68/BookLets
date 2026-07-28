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
    { name: 'IMG-1.jpg', kind: 'image', outcome: 'created', entrySha256: 'sha1' },
    { name: 'IMG-2.jpg', kind: 'image', outcome: 'created', entrySha256: 'sha2' },
    { name: 'IMG-3.jpg', kind: 'image', outcome: 'duplicate', entrySha256: 'sha3' },
    { name: 'IMG-4.jpg', kind: 'image', outcome: 'failed', stage: 'ocr', entrySha256: 'sha4' },
    { name: 'voice.opus', kind: 'unknown', outcome: 'skipped', entrySha256: 'sha5' },
    { name: '_chat.txt', kind: 'text', outcome: 'created', entrySha256: 'sha6' },
  ]),
  findExistingBatchCompletion: vi.fn(async () => null),
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
      { name: 'a', kind: 'image', outcome: 'created', entrySha256: 'sha-a' },
      { name: 'b', kind: 'image', outcome: 'duplicate', entrySha256: 'sha-b' },
      { name: 'c', kind: 'image', outcome: 'failed', stage: 'ocr', entrySha256: 'sha-c' },
      { name: 'd', kind: 'unknown', outcome: 'skipped', entrySha256: 'sha-d' },
      { name: 'e', kind: 'text', outcome: 'created', entrySha256: 'sha-e' },
    ]);
    expect(tally).toEqual({ total: 5, created: 1, deduped: 1, failed: 1, skipped: 1, chatFiles: 1 });
  });

  it('counts an ENTRY once even when it produced several evidence rows', () => {
    // Evidence rows are per-REQUEST, not per-entry: a retried upload writes a
    // second row for the same bytes. Counting rows would report "2 receipts,
    // 1 failed" for one receipt that eventually succeeded.
    const tally = tallyBatch([
      // newest first — the caller orders createdAt desc
      { name: 'IMG-1.jpg', kind: 'image', outcome: 'created', entrySha256: 'sha-1' },
      { name: 'IMG-1.jpg', kind: 'image', outcome: 'failed', stage: 'ocr', entrySha256: 'sha-1' },
    ]);
    expect(tally).toEqual({ total: 1, created: 1, deduped: 0, failed: 0, skipped: 0, chatFiles: 0 });
  });

  it('keeps entries without a content hash distinct rather than collapsing them', () => {
    // A row missing entrySha256 is malformed; merging all such rows into one
    // would under-report. Fall back to the name, then to positional identity.
    const tally = tallyBatch([
      { name: 'a.jpg', kind: 'image', outcome: 'created' },
      { name: 'b.jpg', kind: 'image', outcome: 'created' },
    ]);
    expect(tally.total).toBe(2);
    expect(tally.created).toBe(2);
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

  it('writes exactly ONE completion row when the same batch is closed twice', async () => {
    // A browser retry or a double-click must not append a second
    // WHATSAPP_BATCH_COMPLETED row: an auditor summing completion rows would
    // then double-count an import that happened once. (The journal entries
    // themselves are protected by the idempotency key — this is an
    // audit-trail and reported-counts problem, not a double-booking one.)
    const first = await POST(batchRequest({ batchId: BATCH_ID, archiveName: 'export.zip' }));
    expect(first.status).toBe(200);
    expect(mockDeps.recordEvidence).toHaveBeenCalledTimes(1);

    // Second call sees the completion the first one wrote.
    mockDeps.findExistingBatchCompletion.mockResolvedValueOnce({
      total: 6,
      created: 2,
      deduped: 1,
      failed: 1,
      skipped: 1,
      chatFiles: 1,
    } as never);

    const second = await POST(batchRequest({ batchId: BATCH_ID, archiveName: 'export.zip' }));
    expect(second.status).toBe(200);
    expect(mockDeps.recordEvidence).toHaveBeenCalledTimes(1);

    const body = await second.json();
    expect(body.alreadyRecorded).toBe(true);
    expect(body.summaryRecorded).toBe(true);
    // Same numbers as the first close — a replay reports the run, not a new one.
    expect(body.tally.created).toBe(2);
  });

  it('still answers 200 when the recount query fails — the drafts already landed', async () => {
    mockDeps.loadBatchItemEvidence.mockRejectedValueOnce(new Error('db down'));
    const res = await POST(batchRequest({ batchId: BATCH_ID }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summaryRecorded).toBe(false);
  });
});
