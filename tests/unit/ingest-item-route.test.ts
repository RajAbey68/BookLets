/**
 * POST /api/ingest/item — the per-entry upload endpoint.
 *
 * One WhatsApp archive entry per request, so every request stays far below
 * Vercel's ~4.5 MB edge body limit and every OCR gets its own function
 * invocation (its own timeout budget). Auth, size, filename and type guards are
 * all enforced HERE — the browser's copies in zip-reader.ts are a courtesy to
 * the user, never a control.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

const mockResolveActiveContext = vi.fn();
vi.mock('@/lib/auth-context', () => ({
  resolveActiveContext: (...args: unknown[]) => mockResolveActiveContext(...args),
}));

const mockDeps = {
  ocr: vi.fn(async () => ({
    extraction: {
      vendorName: 'Hardware Store',
      date: '2026-07-01',
      totalAmount: 4500,
      categorySuggestion: 'Other',
      confidence: 0.42,
    },
  })),
  postEntry: vi.fn(async () => ({ id: 'je_1', created: true })),
  findExistingIdempotencyKeys: vi.fn(async () => new Set<string>()),
  resolveLedgerAccounts: vi.fn(async () => ({
    expenseAccountId: 'acct_suspense',
    cashAccountId: 'acct_cash',
  })),
  recordEvidence: vi.fn(async () => {}),
};
// The rate limiter is real (its behaviour is under test); only the prisma/OCR
// backed deps are replaced, so no unit test touches a live DB or the OCR
// microservice.
vi.mock('@/lib/ingest-item.deps', async () => {
  const { RateLimiter } = await import('../../src/lib/upload-guard');
  return {
    buildDefaultItemIngestDeps: () => mockDeps,
    itemRateLimiter: new RateLimiter({ capacity: 60, refillPerMinute: 180 }),
  };
});

import { POST } from '../../src/app/api/ingest/item/route';
import { MAX_ITEM_BYTES } from '../../src/lib/ingest-item';
import { itemRateLimiter } from '../../src/lib/ingest-item.deps';

const AUTHED = {
  ok: true as const,
  context: {
    organizationId: 'org_test_1',
    organizationName: 'Test Org',
    userId: 'user_test_1',
    role: 'OWNER',
  },
};

function jpeg(bytes = 128): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(bytes)]);
}

function itemRequest(
  data: Buffer,
  name = 'IMG-1.jpg',
  extra: Record<string, string> = {},
): Request {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(data)], name));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return new Request('http://localhost/api/ingest/item', { method: 'POST', body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveActiveContext.mockResolvedValue(AUTHED);
  // The limiter is module-level state shared across requests; drain-free start.
  itemRateLimiter.reset();
});

describe('auth', () => {
  it('401s an unauthenticated request before reading the body', async () => {
    mockResolveActiveContext.mockResolvedValue({ ok: false, error: 'Not authenticated.' });
    const res = await POST(itemRequest(jpeg()));
    expect(res.status).toBe(401);
    expect(mockDeps.ocr).not.toHaveBeenCalled();
  });

  it('takes the organisation from the session, never from the request', async () => {
    await POST(itemRequest(jpeg(), 'IMG-1.jpg', { organizationId: 'org_attacker' }));
    const input = (mockDeps.postEntry.mock.calls[0] as unknown[])[0] as { organizationId: string };
    expect(input.organizationId).toBe('org_test_1');
  });
});

describe('happy path', () => {
  it('imports one image as a DRAFT entry and reports the outcome', async () => {
    const res = await POST(itemRequest(jpeg()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.item.outcome).toBe('created');
    expect(body.item.name).toBe('IMG-1.jpg');
    expect(body.item.journalEntryId).toBe('je_1');
  });

  it('accepts the chat transcript and reports message counts', async () => {
    const chat = Buffer.from('12/07/2026, 10:15 - Kumar: Bought cement\n', 'utf8');
    const res = await POST(itemRequest(chat, '_chat.txt'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.item.kind).toBe('text');
    expect(body.item.messageCount).toBe(1);
  });

  it('passes the batch id through to the evidence trail', async () => {
    await POST(itemRequest(jpeg(), 'IMG-1.jpg', { batchId: '4b1e2c3d-0000-4000-8000-000000000001' }));
    const evidence = (mockDeps.recordEvidence.mock.calls.at(-1) as unknown[])[0] as {
      payload: Record<string, unknown>;
    };
    expect(evidence.payload.batchId).toBe('4b1e2c3d-0000-4000-8000-000000000001');
  });
});

describe('guards', () => {
  it('400s when no file part is present', async () => {
    const form = new FormData();
    form.append('batchId', 'x');
    const res = await POST(
      new Request('http://localhost/api/ingest/item', { method: 'POST', body: form }),
    );
    expect(res.status).toBe(400);
  });

  it('413s an item above the per-item byte cap', async () => {
    const big = Buffer.alloc(MAX_ITEM_BYTES + 1024, 0x41);
    const res = await POST(itemRequest(big));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/MB/);
    expect(mockDeps.ocr).not.toHaveBeenCalled();
  });

  it('422s a path-traversal filename', async () => {
    const res = await POST(itemRequest(jpeg(), '../../etc/passwd.jpg'));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('INVALID_NAME');
    expect(mockDeps.ocr).not.toHaveBeenCalled();
  });

  it('200s but reports "skipped" for a disallowed type (not fatal to the batch)', async () => {
    const res = await POST(itemRequest(randomBytes(64), 'voice.opus'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.item.outcome).toBe('skipped');
    expect(mockDeps.ocr).not.toHaveBeenCalled();
  });

  it('200s but reports "skipped" for a renamed non-image', async () => {
    const res = await POST(itemRequest(Buffer.from('MZ not an image'), 'receipt.jpg'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.item.outcome).toBe('skipped');
    expect(mockDeps.ocr).not.toHaveBeenCalled();
  });

  it('rejects a malformed batchId rather than writing it into the audit trail', async () => {
    const res = await POST(itemRequest(jpeg(), 'IMG-1.jpg', { batchId: 'not a uuid\n<script>' }));
    expect(res.status).toBe(400);
    expect(mockDeps.recordEvidence).not.toHaveBeenCalled();
  });

  it('429s once the per-organisation rate limit is exhausted', async () => {
    // The limiter replaces the archive-wide MAX_ZIP_ENTRIES cap: one item per
    // request means the fan-out bound has to live in a rate limit instead.
    let last: Response | null = null;
    for (let i = 0; i < 2000; i += 1) {
      last = await POST(itemRequest(jpeg(8)));
      if (last.status === 429) break;
    }
    expect(last!.status).toBe(429);
    const body = await last!.json();
    expect(body.error).toMatch(/too many|slow down|rate/i);
  });
});
