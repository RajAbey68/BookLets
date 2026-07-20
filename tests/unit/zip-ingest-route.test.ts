/**
 * S5 — POST /api/ingest/zip route handler.
 *
 * Auth-gated like the other API routes (resolveActiveContext → 401), maps
 * guard violations to stable HTTP codes, caps the compressed upload size,
 * and delegates all work to ingestZip with the prisma/OCR-backed default
 * deps (mocked here — no live DB or OCR in unit tests).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AdmZip from 'adm-zip';
import { randomBytes } from 'node:crypto';

const mockResolveActiveContext = vi.fn();
vi.mock('@/lib/auth-context', () => ({
  resolveActiveContext: (...args: unknown[]) => mockResolveActiveContext(...args),
}));

// Replace the prisma/OCR-backed default deps with inert mocks: unit tests
// must never touch a live DB or the OCR microservice.
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
  postEntry: vi.fn(async () => ({ id: 'je_1' })),
  findExistingIdempotencyKeys: vi.fn(async () => new Set<string>()),
  resolveLedgerAccounts: vi.fn(async () => ({
    expenseAccountId: 'acct_suspense',
    cashAccountId: 'acct_cash',
  })),
  recordEvidence: vi.fn(async () => {}),
};
vi.mock('@/lib/zip-ingest.deps', () => ({
  buildDefaultZipIngestDeps: () => mockDeps,
}));

import { POST } from '../../src/app/api/ingest/zip/route';
import { MAX_ZIP_UPLOAD_BYTES } from '../../src/lib/zip-ingest';

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

function goodZip(): Buffer {
  const zip = new AdmZip();
  zip.addFile('_chat.txt', Buffer.from('12/07/2026, 10:15 - Kumar: Bought cement', 'utf8'));
  zip.addFile('photo.jpg', jpeg());
  return zip.toBuffer();
}

function traversalZip(): Buffer {
  const zip = new AdmZip();
  zip.addFile('AA/evil.jpg', jpeg());
  const buf = zip.toBuffer();
  const needle = Buffer.from('AA/evil.jpg', 'utf8');
  const patch = Buffer.from('../evil.jpg', 'utf8');
  let idx = buf.indexOf(needle);
  while (idx !== -1) {
    patch.copy(buf, idx);
    idx = buf.indexOf(needle, idx + patch.length);
  }
  return buf;
}

function multipartRequest(zipBuf: Buffer): Request {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(zipBuf)], { type: 'application/zip' }), 'export.zip');
  return new Request('http://localhost/api/ingest/zip', { method: 'POST', body: form });
}

function rawRequest(zipBuf: Buffer, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/ingest/zip', {
    method: 'POST',
    headers: { 'content-type': 'application/zip', ...headers },
    body: new Uint8Array(zipBuf),
  });
}

beforeEach(() => {
  mockResolveActiveContext.mockReset();
  mockResolveActiveContext.mockResolvedValue(AUTHED);
  mockDeps.ocr.mockClear();
  mockDeps.postEntry.mockClear();
  mockDeps.findExistingIdempotencyKeys.mockClear();
  mockDeps.recordEvidence.mockClear();
});

describe('POST /api/ingest/zip — auth gate', () => {
  it('returns 401 when the session does not resolve', async () => {
    mockResolveActiveContext.mockResolvedValue({ ok: false, error: 'Not authenticated. Sign in to continue.' });
    const res = await POST(multipartRequest(goodZip()));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/Not authenticated/);
    expect(mockDeps.postEntry).not.toHaveBeenCalled();
  });
});

describe('POST /api/ingest/zip — request validation', () => {
  it('returns 400 when the multipart form has no file part', async () => {
    const form = new FormData();
    form.append('note', 'no file here');
    const res = await POST(new Request('http://localhost/api/ingest/zip', { method: 'POST', body: form }));
    expect(res.status).toBe(400);
  });

  it('returns 413 when the declared content-length exceeds the compressed upload cap', async () => {
    const res = await POST(
      rawRequest(goodZip(), { 'content-length': String(MAX_ZIP_UPLOAD_BYTES + 1) }),
    );
    expect(res.status).toBe(413);
    expect(mockDeps.ocr).not.toHaveBeenCalled();
  });

  it('returns 400 for a body that is not a zip', async () => {
    const res = await POST(rawRequest(Buffer.from('not a zip', 'utf8')));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_ZIP');
  });
});

describe('POST /api/ingest/zip — guard mapping', () => {
  it('maps an over-cap image batch to 422 with TOO_MANY_IMAGES and a structured meta payload', async () => {
    // 31 fresh images > MAX_INGEST_IMAGES (30) default → guard trips BEFORE OCR.
    const zip = new AdmZip();
    for (let i = 0; i < 31; i += 1) zip.addFile(`IMG-${i}.jpg`, jpeg());
    const res = await POST(multipartRequest(zip.toBuffer()));

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('TOO_MANY_IMAGES');
    expect(body.meta).toEqual({ limit: 30, actual: 31 });
    expect(mockDeps.ocr).not.toHaveBeenCalled();
    expect(mockDeps.postEntry).not.toHaveBeenCalled();
  });

  it('maps a path-traversal zip to 422 with the guard code', async () => {
    const res = await POST(multipartRequest(traversalZip()));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('PATH_TRAVERSAL');
    expect(mockDeps.ocr).not.toHaveBeenCalled();
    expect(mockDeps.postEntry).not.toHaveBeenCalled();
  });
});

describe('POST /api/ingest/zip — NDJSON streaming progress', () => {
  it('streams one progress event per image then a done event with the report', async () => {
    const zip = new AdmZip();
    zip.addFile('a.jpg', jpeg());
    zip.addFile('b.jpg', jpeg());
    const req = new Request('http://localhost/api/ingest/zip', {
      method: 'POST',
      headers: { 'content-type': 'application/zip', accept: 'application/x-ndjson' },
      body: new Uint8Array(zip.toBuffer()),
    });
    const res = await POST(req);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    const progress = events.filter((e) => e.type === 'progress');
    const done = events.find((e) => e.type === 'done');
    expect(progress).toHaveLength(2);
    expect(progress.map((e) => e.done)).toEqual([1, 2]);
    expect(done.report.created).toBe(2);
  });

  it('emits a terminal error EVENT (200 stream, not an HTTP error) for a guard rejection', async () => {
    const zip = new AdmZip();
    for (let i = 0; i < 31; i += 1) zip.addFile(`IMG-${i}.jpg`, jpeg());
    const req = new Request('http://localhost/api/ingest/zip', {
      method: 'POST',
      headers: { 'content-type': 'application/zip', accept: 'application/x-ndjson' },
      body: new Uint8Array(zip.toBuffer()),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    const err = events.find((e) => e.type === 'error');
    expect(err.status).toBe(422);
    expect(err.code).toBe('TOO_MANY_IMAGES');
    expect(err.meta).toEqual({ limit: 30, actual: 31 });
    expect(mockDeps.postEntry).not.toHaveBeenCalled();
  });
});

describe('POST /api/ingest/zip — happy path', () => {
  it('processes a multipart upload and returns the ingest report', async () => {
    const res = await POST(multipartRequest(goodZip()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report.imageCount).toBe(1);
    expect(body.report.textCount).toBe(1);
    expect(body.report.created).toBe(1);
    expect(body.report.zipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(mockDeps.ocr).toHaveBeenCalledTimes(1);
    expect(mockDeps.postEntry).toHaveBeenCalledTimes(1);
  });

  it('also accepts a raw application/zip body (curl-friendly for the devserver run)', async () => {
    const res = await POST(rawRequest(goodZip()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report.created).toBe(1);
  });
});
