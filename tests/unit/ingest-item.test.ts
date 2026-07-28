/**
 * Server-side per-item ingest core.
 *
 * The browser now expands the WhatsApp archive and uploads one entry per
 * request (see zip-reader.ts). That moves the EXPANSION to the client but must
 * NOT move the trust boundary: every guard inspectZip used to apply to an entry
 * has to be re-applied here, server-side, to bytes the server received.
 *
 *   entry-count cap        → per-request (exactly one item) + rate limiter
 *   uncompressed size cap  → MAX_ITEM_BYTES on the received bytes
 *   path traversal         → sanitizeEntryName on the client-supplied filename
 *   zip-bomb ratio         → structurally N/A: the server inflates nothing
 *   type allowlist         → extension allowlist + magic bytes on real bytes
 *
 * Money correctness: the idempotency key is derived by the SAME function the
 * zip path uses (computeEntryIdempotencyKey over sha256 of the entry bytes), so
 * a receipt imported through either transport dedupes against the other.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  ingestItem,
  sanitizeEntryName,
  classifyEntryName,
  ItemIngestError,
  MAX_ITEM_BYTES,
  MAX_ITEM_NAME_LENGTH,
  type ItemIngestDeps,
} from '../../src/lib/ingest-item';
import {
  computeEntryIdempotencyKey,
  ZIP_INGEST_SOURCE,
  ZIP_INGEST_JOURNAL_STATUS,
} from '../../src/lib/zip-ingest';
import { JournalStatus } from '../../src/lib/types';

const CTX = { organizationId: 'org_1', userId: 'user_1' };

function jpeg(bytes = 128): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(bytes)]);
}

function makeDeps(overrides: Partial<ItemIngestDeps> = {}): ItemIngestDeps {
  return {
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
    ...overrides,
  } as ItemIngestDeps;
}

describe('sanitizeEntryName — the path-traversal guard, moved to the item boundary', () => {
  it('strips directory components from a nested WhatsApp media path', () => {
    expect(sanitizeEntryName('media/IMG-20260712-WA0001.jpg')).toBe('IMG-20260712-WA0001.jpg');
  });

  it('rejects a ".." traversal name', () => {
    expect(() => sanitizeEntryName('../../etc/passwd.jpg')).toThrow(ItemIngestError);
    try {
      sanitizeEntryName('../evil.jpg');
    } catch (err) {
      expect((err as ItemIngestError).code).toBe('INVALID_NAME');
    }
  });

  it('rejects an absolute path and a Windows drive prefix', () => {
    expect(() => sanitizeEntryName('/etc/shadow.jpg')).toThrow(ItemIngestError);
    expect(() => sanitizeEntryName('C:\\Windows\\evil.jpg')).toThrow(ItemIngestError);
  });

  it('rejects a name that is only separators or empty after stripping', () => {
    expect(() => sanitizeEntryName('media/')).toThrow(ItemIngestError);
    expect(() => sanitizeEntryName('   ')).toThrow(ItemIngestError);
  });

  it('strips control characters and newlines (log/UI injection defence)', () => {
    expect(sanitizeEntryName('re\u0000ceipt\n.jpg')).toBe('receipt.jpg');
  });

  it('caps an absurdly long name while keeping its extension', () => {
    const long = `${'a'.repeat(5000)}.jpg`;
    const safe = sanitizeEntryName(long);
    expect(safe.length).toBeLessThanOrEqual(MAX_ITEM_NAME_LENGTH);
    expect(safe.endsWith('.jpg')).toBe(true);
  });
});

describe('classifyEntryName — the type allowlist, applied server-side', () => {
  it.each(['a.jpg', 'a.JPEG', 'a.png', 'a.webp', 'a.heic'])('treats %s as an image', (name) => {
    expect(classifyEntryName(name)).toBe('image');
  });

  it('treats .txt as chat text', () => {
    expect(classifyEntryName('_chat.txt')).toBe('text');
  });

  it.each(['a.opus', 'a.mp4', 'a.pdf', 'a.exe', 'noextension'])('rejects %s', (name) => {
    expect(classifyEntryName(name)).toBeNull();
  });
});

describe('ingestItem — image path', () => {
  let deps: ItemIngestDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('creates exactly one DRAFT entry with the zip path’s idempotency key', async () => {
    const bytes = jpeg();
    const sha = createHash('sha256').update(bytes).digest('hex');
    const result = await ingestItem(bytes, 'media/IMG-1.jpg', CTX, deps);

    expect(result.outcome).toBe('created');
    expect(result.kind).toBe('image');
    expect(result.name).toBe('IMG-1.jpg');
    expect(result.sha256).toBe(sha);
    expect(result.journalEntryId).toBe('je_1');

    const input = (deps.postEntry as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(input.idempotencyKey).toBe(computeEntryIdempotencyKey('org_1', sha));
    expect(input.status).toBe(JournalStatus.DRAFT);
    expect(input.status).toBe(ZIP_INGEST_JOURNAL_STATUS);
    expect(input.source).toBe(ZIP_INGEST_SOURCE);
    expect(input.sourceId).toBe(sha);
    expect(input.organizationId).toBe('org_1');
    expect(input.tenantId).toBe('org_1');
    expect(input.makerIdentity).toBe(`${ZIP_INGEST_SOURCE}:user_1`);
  });

  it('never posts anything other than DRAFT, even at confidence 1.0', async () => {
    deps = makeDeps({
      ocr: vi.fn(async () => ({
        extraction: {
          vendorName: 'V',
          date: '2026-07-01',
          totalAmount: 100,
          categorySuggestion: 'Other',
          confidence: 1,
        },
      })),
    });
    await ingestItem(jpeg(), 'a.jpg', CTX, deps);
    const input = (deps.postEntry as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(input.status).toBe(JournalStatus.DRAFT);
  });

  it('skips OCR entirely when the key is already in the books (dedup, no spend)', async () => {
    const bytes = jpeg();
    const sha = createHash('sha256').update(bytes).digest('hex');
    deps = makeDeps({
      findExistingIdempotencyKeys: vi.fn(async () =>
        new Set([computeEntryIdempotencyKey('org_1', sha)]),
      ),
    });
    const result = await ingestItem(bytes, 'a.jpg', CTX, deps);
    expect(result.outcome).toBe('duplicate');
    expect(deps.ocr).not.toHaveBeenCalled();
    expect(deps.postEntry).not.toHaveBeenCalled();
  });

  it('reports a duplicate truthfully when the ledger reports created:false (race)', async () => {
    deps = makeDeps({ postEntry: vi.fn(async () => ({ id: 'je_existing', created: false })) });
    const result = await ingestItem(jpeg(), 'a.jpg', CTX, deps);
    expect(result.outcome).toBe('duplicate');
    expect(result.journalEntryId).toBe('je_existing');
  });

  it('rejects bytes above the per-item cap before any OCR spend', async () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(MAX_ITEM_BYTES)]);
    const result = await ingestItem(big, 'a.jpg', CTX, deps);
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toMatch(/too large/i);
    expect(deps.ocr).not.toHaveBeenCalled();
  });

  it('rejects an empty item', async () => {
    const result = await ingestItem(Buffer.alloc(0), 'a.jpg', CTX, deps);
    expect(result.outcome).toBe('skipped');
    expect(deps.ocr).not.toHaveBeenCalled();
  });

  it('rejects a disallowed extension without touching OCR', async () => {
    const result = await ingestItem(jpeg(), 'malware.exe', CTX, deps);
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toMatch(/\.exe/);
    expect(deps.ocr).not.toHaveBeenCalled();
  });

  it('rejects a renamed non-image: magic bytes beat the extension', async () => {
    const notAnImage = Buffer.from('MZ\u0090\u0000this is a windows executable', 'binary');
    const result = await ingestItem(notAnImage, 'receipt.jpg', CTX, deps);
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toMatch(/unrecognisable|not a recognisable|Unsupported/i);
    expect(deps.ocr).not.toHaveBeenCalled();
  });

  it('throws INVALID_NAME for a traversal filename rather than importing it', async () => {
    await expect(ingestItem(jpeg(), '../evil.jpg', CTX, deps)).rejects.toMatchObject({
      code: 'INVALID_NAME',
    });
  });

  it('records an OCR failure without creating a ledger entry', async () => {
    deps = makeDeps({ ocr: vi.fn(async () => { throw new Error('OCR service unavailable'); }) });
    const result = await ingestItem(jpeg(), 'a.jpg', CTX, deps);
    expect(result.outcome).toBe('failed');
    expect(result.stage).toBe('ocr');
    expect(result.reason).toMatch(/OCR service unavailable/);
    expect(deps.postEntry).not.toHaveBeenCalled();
  });

  it('refuses a zero or negative OCR amount instead of booking a garbage entry', async () => {
    deps = makeDeps({
      ocr: vi.fn(async () => ({
        extraction: {
          vendorName: 'V',
          date: '2026-07-01',
          totalAmount: 0,
          categorySuggestion: 'Other',
          confidence: 0.9,
        },
      })),
    });
    const result = await ingestItem(jpeg(), 'a.jpg', CTX, deps);
    expect(result.outcome).toBe('failed');
    expect(deps.postEntry).not.toHaveBeenCalled();
  });

  it('reports a ledger failure per item without throwing', async () => {
    deps = makeDeps({ postEntry: vi.fn(async () => { throw new Error('no fiscal period'); }) });
    const result = await ingestItem(jpeg(), 'a.jpg', CTX, deps);
    expect(result.outcome).toBe('failed');
    expect(result.stage).toBe('ledger');
    expect(result.reason).toMatch(/no fiscal period/);
  });

  it('carries the batch id and content hash into the per-item evidence row', async () => {
    const bytes = jpeg();
    const sha = createHash('sha256').update(bytes).digest('hex');
    await ingestItem(bytes, 'a.jpg', CTX, deps, { batchId: 'batch-abc' });
    const evidence = (deps.recordEvidence as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    expect(evidence.eventType).toBe('WHATSAPP_ITEM_INGESTED');
    expect(evidence.tenantId).toBe('org_1');
    expect(evidence.payload.batchId).toBe('batch-abc');
    expect(evidence.payload.entrySha256).toBe(sha);
    expect(evidence.payload.outcome).toBe('created');
  });
});

describe('ingestItem — chat text path', () => {
  it('records chat evidence with the same shape the zip path produced', async () => {
    const deps = makeDeps();
    const chat = Buffer.from(
      '12/07/2026, 10:15 - Kumar: Bought cement\n12/07/2026, 10:16 - Raj: ok\n',
      'utf8',
    );
    const result = await ingestItem(chat, '_chat.txt', CTX, deps, { batchId: 'batch-abc' });

    expect(result.kind).toBe('text');
    expect(result.outcome).toBe('created');
    expect(result.messageCount).toBe(2);
    expect(result.participants).toEqual(['Kumar', 'Raj']);

    const calls = (deps.recordEvidence as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    const chatEvidence = calls.find((e) => e.eventType === 'ZIP_CHAT_INGESTED');
    expect(chatEvidence).toBeTruthy();
    expect(chatEvidence.payload.entryName).toBe('_chat.txt');
    expect(chatEvidence.payload.messageCount).toBe(2);
    expect(chatEvidence.payload.participants).toEqual(['Kumar', 'Raj']);
    expect(chatEvidence.payload.text).toContain('Bought cement');
    expect(chatEvidence.payload.batchId).toBe('batch-abc');
    expect(deps.ocr).not.toHaveBeenCalled();
  });

  it('truncates an enormous transcript rather than storing it whole', async () => {
    const deps = makeDeps();
    const chat = Buffer.from('x'.repeat(80_000), 'utf8');
    await ingestItem(chat, '_chat.txt', CTX, deps);
    const calls = (deps.recordEvidence as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    const chatEvidence = calls.find((e) => e.eventType === 'ZIP_CHAT_INGESTED');
    expect(chatEvidence.payload.textTruncated).toBe(true);
    expect((chatEvidence.payload.text as string).length).toBeLessThan(80_000);
  });

  it('never creates a journal entry from chat text', async () => {
    const deps = makeDeps();
    await ingestItem(Buffer.from('hello', 'utf8'), '_chat.txt', CTX, deps);
    expect(deps.postEntry).not.toHaveBeenCalled();
  });
});
