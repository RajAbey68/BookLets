/**
 * POST /api/ingest/statement route handler.
 *
 * Auth-gated like the other ingest routes (resolveActiveContext → 401, then
 * an OWNER/ADMIN role gate → 403 exactly like the ocr-bridge route), caps the
 * upload size, maps guard violations to stable HTTP codes, and delegates all
 * work to ingestStatement with the prisma-backed default deps (mocked here —
 * no live DB in unit tests).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockResolveActiveContext = vi.fn();
vi.mock('@/lib/auth-context', () => ({
  resolveActiveContext: (...args: unknown[]) => mockResolveActiveContext(...args),
}));

// Replace the prisma-backed default deps with inert mocks: unit tests must
// never touch a live database.
const mockDeps = {
  postEntry: vi.fn(async () => ({ entryId: 'je_1', created: true })),
  findExistingIdempotencyKeys: vi.fn(async () => new Set<string>()),
  resolveStatementAccounts: vi.fn(async () => ({
    bankAccountId: 'acct_bank',
    suspenseAccountId: 'acct_suspense',
  })),
  hasOpenFiscalPeriod: vi.fn(async () => true),
  recordEvidence: vi.fn(async () => {}),
};
vi.mock('@/lib/statement-ingest.deps', () => ({
  buildDefaultStatementIngestDeps: () => mockDeps,
}));

import { POST } from '../../src/app/api/ingest/statement/route';
import { MAX_STATEMENT_UPLOAD_BYTES } from '../../src/lib/statement-ingest';

const AUTHED = {
  ok: true as const,
  context: {
    organizationId: 'org_test_1',
    organizationName: 'Test Org',
    userId: 'user_test_1',
    role: 'OWNER',
  },
};

const GOOD_CSV = [
  '"TransferWise ID",Date,Amount,Currency,Description,"Running Balance"',
  'TRANSFER-1001,01-07-2026,-4500.00,LKR,"Cement purchase, hardware store",95500.00',
  'TRANSFER-1002,02-07-2026,120000.00,LKR,Booking payout,215500.00',
].join('\n');

function multipartRequest(csv: string): Request {
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'statement.csv');
  return new Request('http://localhost/api/ingest/statement', { method: 'POST', body: form });
}

function rawRequest(body: Buffer | string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/ingest/statement', {
    method: 'POST',
    headers: { 'content-type': 'text/csv', ...headers },
    body: typeof body === 'string' ? body : new Uint8Array(body),
  });
}

beforeEach(() => {
  mockResolveActiveContext.mockReset();
  mockResolveActiveContext.mockResolvedValue(AUTHED);
  mockDeps.postEntry.mockClear();
  mockDeps.findExistingIdempotencyKeys.mockClear();
  mockDeps.recordEvidence.mockClear();
});

describe('POST /api/ingest/statement — auth gates', () => {
  it('returns 401 when the session does not resolve', async () => {
    mockResolveActiveContext.mockResolvedValue({
      ok: false,
      error: 'Not authenticated. Sign in to continue.',
    });
    const res = await POST(multipartRequest(GOOD_CSV));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/Not authenticated/);
    expect(mockDeps.postEntry).not.toHaveBeenCalled();
  });

  it('returns 403 for members below OWNER/ADMIN', async () => {
    for (const role of ['BOOKKEEPER', 'ACCOUNTANT', 'VIEWER']) {
      mockResolveActiveContext.mockResolvedValue({
        ok: true,
        context: { ...AUTHED.context, role },
      });
      const res = await POST(multipartRequest(GOOD_CSV));
      expect(res.status).toBe(403);
    }
    expect(mockDeps.postEntry).not.toHaveBeenCalled();
  });
});

describe('POST /api/ingest/statement — request validation', () => {
  it('returns 400 when the multipart form has no file part', async () => {
    const form = new FormData();
    form.append('note', 'no file here');
    const res = await POST(
      new Request('http://localhost/api/ingest/statement', { method: 'POST', body: form }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for an empty body', async () => {
    const res = await POST(rawRequest(''));
    expect(res.status).toBe(400);
  });

  it('returns 413 when the declared content-length exceeds the upload cap', async () => {
    const res = await POST(
      rawRequest(GOOD_CSV, { 'content-length': String(MAX_STATEMENT_UPLOAD_BYTES + 1) }),
    );
    expect(res.status).toBe(413);
    expect(mockDeps.postEntry).not.toHaveBeenCalled();
  });

  it('returns 413 when the actual body exceeds the upload cap', async () => {
    // Padding rides in a data row so the payload is well-formed CSV right up
    // to the byte cap — only FILE_TOO_LARGE can be the rejection reason.
    const oversized =
      'Date,Description,Amount\n' +
      `2026-07-01,${'x'.repeat(MAX_STATEMENT_UPLOAD_BYTES + 1)},-1.00\n`;
    const res = await POST(rawRequest(oversized));
    expect(res.status).toBe(413);
    expect(mockDeps.postEntry).not.toHaveBeenCalled();
  });
});

describe('POST /api/ingest/statement — guard mapping', () => {
  it('maps a header missing Date/Amount/Description to 422 MISSING_COLUMNS', async () => {
    const res = await POST(multipartRequest('Foo,Bar,Baz\n1,2,3'));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('MISSING_COLUMNS');
    expect(mockDeps.postEntry).not.toHaveBeenCalled();
  });

  it('maps malformed CSV (unterminated quote) to 400 INVALID_CSV', async () => {
    const res = await POST(multipartRequest('Date,Description,Amount\n2026-07-01,"broken,-1'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_CSV');
  });
});

describe('POST /api/ingest/statement — happy path', () => {
  it('processes a multipart upload and returns the ingest report', async () => {
    const res = await POST(multipartRequest(GOOD_CSV));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report.totalRows).toBe(2);
    expect(body.report.created).toBe(2);
    expect(body.report.deduped).toBe(0);
    expect(body.report.statementHash).toMatch(/^[0-9a-f]{64}$/);
    expect(mockDeps.postEntry).toHaveBeenCalledTimes(2);
  });

  it('also accepts a raw text/csv body (curl-friendly)', async () => {
    const res = await POST(rawRequest(GOOD_CSV));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report.created).toBe(2);
  });
});
