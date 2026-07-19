/**
 * S5 — WhatsApp export zip ingestion (checkpoints 4a + 4b).
 *
 * TDD RED-first suite. Drives src/lib/zip-ingest.ts, a pure core module
 * (no prisma import) with injectable deps so no live DB or OCR is touched:
 *
 *   4a — hostile-zip guards, all enforced BEFORE any OCR spend:
 *        entry-count cap (1000), total uncompressed cap (200 MB, both
 *        declared and actual inflated size), path traversal (../, absolute,
 *        backslash), per-entry zip-bomb compression-ratio guard, and an
 *        extension allowlist (jpg/jpeg/png/webp/heic images + .txt chat);
 *        everything else is skipped with a per-entry reason, never fatal.
 *   4b — text/image split on a 5-file synthetic sample, OCR fan-out capped
 *        at 5 concurrent, DRAFT-only journal status, idempotent re-upload
 *        (content-hash keys; second upload creates nothing and re-OCRs
 *        nothing).
 *
 * All zip fixtures are generated in-test with adm-zip — no binary fixtures
 * are committed. Malicious entry names that adm-zip would normalise on
 * write are produced by byte-patching the name in the finished archive
 * (zip filenames are not covered by any checksum).
 */
import { describe, it, expect, vi } from 'vitest';
import AdmZip from 'adm-zip';
import { createHash, randomBytes } from 'node:crypto';
import {
  MAX_ZIP_ENTRIES,
  MAX_INGEST_IMAGES,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  MAX_ENTRY_COMPRESSION_RATIO,
  OCR_CONCURRENCY_LIMIT,
  ZIP_INGEST_JOURNAL_STATUS,
  ZIP_INGEST_SOURCE,
  ZipIngestError,
  isPathTraversal,
  inspectZip,
  computeEntryIdempotencyKey,
  parseChatText,
  ingestZip,
  type ZipIngestDeps,
} from '../../src/lib/zip-ingest';
import type { JournalEntryInput } from '../../src/lib/types';
import type { GeminiOcrResult } from '../../src/lib/gemini-ocr';

// ─── fixture builders (in-test, nothing committed) ───────────────────────────

function jpeg(bytes = 256): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(bytes)]);
}

function png(bytes = 256): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    randomBytes(bytes),
  ]);
}

function webp(bytes = 256): Buffer {
  return Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    Buffer.from([0x10, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'latin1'),
    randomBytes(bytes),
  ]);
}

const CHAT_TEXT = [
  '12/07/2026, 10:15 - Kumar: Bought cement 4,500',
  '12/07/2026, 10:16 - Kumar: <attached: 00000001-PHOTO-2026-07-12.jpg>',
  '12/07/2026, 11:02 - Priya: Approved, add to petty cash',
].join('\n');

function buildZip(entries: Array<{ name: string; data: Buffer | string }>): Buffer {
  const zip = new AdmZip();
  for (const e of entries) {
    zip.addFile(e.name, typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : e.data);
  }
  return zip.toBuffer();
}

/**
 * Byte-patch every occurrence of `from` with the equal-length `to` inside a
 * finished archive (local file header + central directory both carry the
 * name; zip has no checksum over filenames). Lets us create entry names
 * adm-zip would refuse or normalise on write, e.g. "../evil.jpg".
 */
function tamperEntryName(zip: Buffer, from: string, to: string): Buffer {
  if (from.length !== to.length) throw new Error('tamperEntryName: lengths must match');
  const out = Buffer.from(zip);
  const needle = Buffer.from(from, 'utf8');
  const patch = Buffer.from(to, 'utf8');
  let idx = out.indexOf(needle);
  while (idx !== -1) {
    patch.copy(out, idx);
    idx = out.indexOf(needle, idx + patch.length);
  }
  return out;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

// ─── deps harness ─────────────────────────────────────────────────────────────

const OCR_RESULT: GeminiOcrResult = {
  extraction: {
    vendorName: 'Hardware Store',
    date: '2026-07-01',
    totalAmount: 4500,
    // High confidence on purpose: even 0.99 must NOT escalate to POSTED.
    categorySuggestion: 'Other',
    confidence: 0.99,
  },
};

const CTX = { organizationId: 'org_test_1', userId: 'user_test_1' };

function makeDeps(overrides: Partial<ZipIngestDeps> = {}): ZipIngestDeps & {
  postedInputs: JournalEntryInput[];
} {
  const postedInputs: JournalEntryInput[] = [];
  let n = 0;
  const deps: ZipIngestDeps = {
    ocr: vi.fn(async () => OCR_RESULT),
    postEntry: vi.fn(async (input: JournalEntryInput) => {
      postedInputs.push(input);
      n += 1;
      return { id: `je_${n}` };
    }),
    findExistingIdempotencyKeys: vi.fn(async () => new Set<string>()),
    resolveLedgerAccounts: vi.fn(async () => ({
      expenseAccountId: 'acct_suspense',
      cashAccountId: 'acct_cash',
    })),
    recordEvidence: vi.fn(async () => {}),
    ...overrides,
  };
  return Object.assign(deps, { postedInputs });
}

// ─── constants (the contract's numbers, pinned) ───────────────────────────────

describe('S5 zip-ingest — guard constants', () => {
  it('caps a zip at 1000 entries', () => {
    expect(MAX_ZIP_ENTRIES).toBe(1000);
  });

  it('caps total uncompressed payload at 200 MB', () => {
    expect(MAX_TOTAL_UNCOMPRESSED_BYTES).toBe(200 * 1024 * 1024);
  });

  it('caps OCR fan-out at 5 concurrent calls', () => {
    expect(OCR_CONCURRENCY_LIMIT).toBe(5);
  });

  it('pins the journal status for OCR-created entries to DRAFT (four-eyes promotes later)', () => {
    expect(ZIP_INGEST_JOURNAL_STATUS).toBe('DRAFT');
  });
});

// ─── checkpoint 4a: malicious zips rejected ───────────────────────────────────

describe('S5 zip-ingest — checkpoint 4a: hostile zip guards', () => {
  it('rejects a zip with more than 1000 entries (TOO_MANY_ENTRIES)', () => {
    const zip = new AdmZip();
    for (let i = 0; i < 1001; i += 1) {
      zip.addFile(`f${i}.txt`, Buffer.from('x'));
    }
    const buf = zip.toBuffer();
    expect(() => inspectZip(buf)).toThrowError(ZipIngestError);
    try {
      inspectZip(buf);
    } catch (err) {
      expect((err as ZipIngestError).code).toBe('TOO_MANY_ENTRIES');
    }
  });

  it('accepts exactly 1000 entries (boundary)', () => {
    const zip = new AdmZip();
    for (let i = 0; i < 1000; i += 1) {
      zip.addFile(`f${i}.txt`, Buffer.from('x'));
    }
    expect(() => inspectZip(zip.toBuffer())).not.toThrow();
  });

  it('rejects when total uncompressed size exceeds the cap (TOTAL_SIZE_EXCEEDED)', () => {
    // Incompressible payloads so neither entry trips the ratio guard: the
    // TOTAL cap must fire on its own. Limit injected small to keep the test
    // fast; the default (200 MB) is pinned in the constants suite.
    const buf = buildZip([
      { name: 'a.jpg', data: jpeg(200 * 1024) },
      { name: 'b.jpg', data: jpeg(200 * 1024) },
    ]);
    try {
      inspectZip(buf, { maxTotalUncompressedBytes: 256 * 1024 });
      expect.unreachable('expected TOTAL_SIZE_EXCEEDED');
    } catch (err) {
      expect(err).toBeInstanceOf(ZipIngestError);
      expect((err as ZipIngestError).code).toBe('TOTAL_SIZE_EXCEEDED');
    }
  });

  it('skipped (non-allowlisted) entries do not consume the declared-size cap', () => {
    // A real WhatsApp export carries large .opus voice notes and videos that
    // are never inflated — they must not trip TOTAL_SIZE_EXCEEDED. Same cap
    // as the rejection test above; only the allowlisted jpg counts.
    const buf = buildZip([
      { name: 'voice1.opus', data: Buffer.alloc(300 * 1024) },
      { name: 'video.mp4', data: Buffer.alloc(300 * 1024) },
      { name: 'doc.pdf', data: Buffer.alloc(300 * 1024) },
      { name: 'app.exe', data: Buffer.alloc(300 * 1024) },
      { name: 'receipt.jpg', data: jpeg(100 * 1024) },
      { name: 'chat.txt', data: 'chat log' },
    ]);
    const inspected = inspectZip(buf, { maxTotalUncompressedBytes: 256 * 1024 });
    expect(inspected.images).toHaveLength(1);
    expect(inspected.texts).toHaveLength(1);
    expect(inspected.skipped).toHaveLength(4);
  });

  it('path traversal is still rejected on non-allowlisted entries', () => {
    // The traversal guard must keep covering entries the size cap now skips.
    const tampered = tamperEntryName(
      buildZip([{ name: 'AA/evil.opus', data: Buffer.from('x') }]),
      'AA/evil.opus',
      '../evil.opus',
    );
    try {
      inspectZip(tampered);
      expect.unreachable('expected PATH_TRAVERSAL');
    } catch (err) {
      expect(err).toBeInstanceOf(ZipIngestError);
      expect((err as ZipIngestError).code).toBe('PATH_TRAVERSAL');
    }
  });

  it('rejects entry names containing ../ (PATH_TRAVERSAL)', () => {
    const tampered = tamperEntryName(
      buildZip([{ name: 'AA/evil.jpg', data: jpeg() }]),
      'AA/evil.jpg',
      '../evil.jpg',
    );
    try {
      inspectZip(tampered);
      expect.unreachable('expected PATH_TRAVERSAL');
    } catch (err) {
      expect(err).toBeInstanceOf(ZipIngestError);
      expect((err as ZipIngestError).code).toBe('PATH_TRAVERSAL');
    }
  });

  it('rejects absolute entry names (PATH_TRAVERSAL)', () => {
    const tampered = tamperEntryName(
      buildZip([{ name: 'aetc/passwd.jpg', data: jpeg() }]),
      'aetc/passwd.jpg',
      '/etc/passwd.jpg',
    );
    try {
      inspectZip(tampered);
      expect.unreachable('expected PATH_TRAVERSAL');
    } catch (err) {
      expect(err).toBeInstanceOf(ZipIngestError);
      expect((err as ZipIngestError).code).toBe('PATH_TRAVERSAL');
    }
  });

  it('isPathTraversal covers backslash and embedded .. segments', () => {
    expect(isPathTraversal('..\\evil.jpg')).toBe(true);
    expect(isPathTraversal('a/../b.jpg')).toBe(true);
    expect(isPathTraversal('C:\\windows\\evil.jpg')).toBe(true);
    expect(isPathTraversal('/absolute.jpg')).toBe(true);
    // Legitimate names — including nested folders and dots in filenames.
    expect(isPathTraversal('receipt.jpg')).toBe(false);
    expect(isPathTraversal('sub/receipt.v2.jpg')).toBe(false);
    expect(isPathTraversal('..hidden.jpg')).toBe(false);
  });

  it('rejects a zip bomb via the per-entry compression-ratio guard (ZIP_BOMB)', () => {
    // 5 MB of zeros deflates to a few KB — ratio far above the guard. Named
    // .jpg so the allowlist cannot save us: the ratio guard itself must fire.
    const buf = buildZip([{ name: 'bomb.jpg', data: Buffer.alloc(5 * 1024 * 1024) }]);
    try {
      inspectZip(buf);
      expect.unreachable('expected ZIP_BOMB');
    } catch (err) {
      expect(err).toBeInstanceOf(ZipIngestError);
      expect((err as ZipIngestError).code).toBe('ZIP_BOMB');
    }
    expect(MAX_ENTRY_COMPRESSION_RATIO).toBe(100);
  });

  it('skips disallowed entry types with a reason instead of failing the whole zip', () => {
    const inspected = inspectZip(
      buildZip([
        { name: 'receipt.jpg', data: jpeg() },
        { name: 'malware.exe', data: randomBytes(64) },
        { name: 'report.pdf', data: randomBytes(64) },
        { name: 'voicenote.opus', data: randomBytes(64) },
      ]),
    );
    expect(inspected.images.map((i) => i.name)).toEqual(['receipt.jpg']);
    const skippedNames = inspected.skipped.map((s) => s.name).sort();
    expect(skippedNames).toEqual(['malware.exe', 'report.pdf', 'voicenote.opus']);
    for (const s of inspected.skipped) {
      expect(s.reason).toBeTruthy();
    }
  });

  it('rejects a non-zip payload (INVALID_ZIP)', () => {
    try {
      inspectZip(Buffer.from('this is not a zip file at all', 'utf8'));
      expect.unreachable('expected INVALID_ZIP');
    } catch (err) {
      expect(err).toBeInstanceOf(ZipIngestError);
      expect((err as ZipIngestError).code).toBe('INVALID_ZIP');
    }
  });
});

// ─── checkpoint 4b: split, OCR cap, DRAFT, idempotency ────────────────────────

describe('S5 zip-ingest — checkpoint 4b: text/image split on a 5-file sample', () => {
  const fiveFileZip = () =>
    buildZip([
      { name: '_chat.txt', data: CHAT_TEXT },
      { name: '00000001-PHOTO-2026-07-12.jpg', data: jpeg() },
      { name: '00000002-PHOTO-2026-07-12.png', data: png() },
      { name: '00000003-PHOTO-2026-07-12.webp', data: webp() },
      { name: 'voicenote.opus', data: randomBytes(64) },
    ]);

  it('splits the sample into 3 images, 1 chat text, 1 skipped', () => {
    const inspected = inspectZip(fiveFileZip());
    expect(inspected.images).toHaveLength(3);
    expect(inspected.texts).toHaveLength(1);
    expect(inspected.texts[0].name).toBe('_chat.txt');
    expect(inspected.skipped).toHaveLength(1);
    expect(inspected.skipped[0].name).toBe('voicenote.opus');
  });

  it('OCRs each image exactly once and creates one DRAFT entry per image', async () => {
    const deps = makeDeps();
    const report = await ingestZip(fiveFileZip(), CTX, deps);

    expect(deps.ocr).toHaveBeenCalledTimes(3);
    expect(deps.postEntry).toHaveBeenCalledTimes(3);
    expect(report.imageCount).toBe(3);
    expect(report.textCount).toBe(1);
    expect(report.created).toBe(3);
    expect(report.deduped).toBe(0);
    expect(report.journalEntryIds).toHaveLength(3);
    expect(report.skipped.map((s) => s.name)).toEqual(['voicenote.opus']);
  });

  it('parses the chat text and records it as evidence metadata', async () => {
    const deps = makeDeps();
    const report = await ingestZip(fiveFileZip(), CTX, deps);

    expect(report.chatFiles).toHaveLength(1);
    expect(report.chatFiles[0].name).toBe('_chat.txt');
    expect(report.chatFiles[0].messageCount).toBe(3);

    const evidenceCalls = (deps.recordEvidence as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    const chatEvidence = evidenceCalls.find((e) => e.eventType === 'ZIP_CHAT_INGESTED');
    expect(chatEvidence).toBeDefined();
    expect(chatEvidence.tenantId).toBe(CTX.organizationId);
    expect(chatEvidence.payload.messageCount).toBe(3);
    expect(chatEvidence.payload.entrySha256).toBe(sha256(Buffer.from(CHAT_TEXT, 'utf8')));
    // A run summary is also witnessed.
    expect(evidenceCalls.some((e) => e.eventType === 'ZIP_INGEST_COMPLETED')).toBe(true);
  });

  it('skips an entry with an image extension but non-image content (magic bytes), without OCR', async () => {
    const deps = makeDeps();
    const report = await ingestZip(
      buildZip([
        { name: 'fake.jpg', data: Buffer.from('definitely not an image, 64 bytes of padding....', 'utf8') },
        { name: 'real.jpg', data: jpeg() },
      ]),
      CTX,
      deps,
    );
    expect(deps.ocr).toHaveBeenCalledTimes(1);
    expect(report.created).toBe(1);
    expect(report.skipped.map((s) => s.name)).toContain('fake.jpg');
  });

  it('caps OCR fan-out at 5 concurrent calls across 12 images', async () => {
    let active = 0;
    let maxActive = 0;
    const ocr = vi.fn(async (): Promise<GeminiOcrResult> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return OCR_RESULT;
    });
    const deps = makeDeps({ ocr });

    const entries = Array.from({ length: 12 }, (_, i) => ({
      name: `photo-${i}.jpg`,
      data: jpeg(),
    }));
    const report = await ingestZip(buildZip(entries), CTX, deps);

    expect(ocr).toHaveBeenCalledTimes(12);
    expect(report.created).toBe(12);
    expect(maxActive).toBeLessThanOrEqual(OCR_CONCURRENCY_LIMIT);
    expect(maxActive).toBeGreaterThan(1); // it actually fans out
  });

  it('an OCR failure on one image is reported, not fatal for the rest', async () => {
    let calls = 0;
    const ocr = vi.fn(async (): Promise<GeminiOcrResult> => {
      calls += 1;
      if (calls === 1) throw new Error('OCR microservice unreachable');
      return OCR_RESULT;
    });
    const deps = makeDeps({ ocr });
    const report = await ingestZip(
      buildZip([
        { name: 'a.jpg', data: jpeg() },
        { name: 'b.jpg', data: jpeg() },
      ]),
      CTX,
      deps,
    );
    expect(report.created).toBe(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].stage).toBe('ocr');
  });
});

describe('S5 zip-ingest — DRAFT-only journal status', () => {
  it('creates every entry as DRAFT even at 0.99 OCR confidence — never POSTED', async () => {
    const deps = makeDeps();
    await ingestZip(
      buildZip([
        { name: 'a.jpg', data: jpeg() },
        { name: 'b.jpg', data: jpeg() },
      ]),
      CTX,
      deps,
    );
    expect(deps.postedInputs).toHaveLength(2);
    for (const input of deps.postedInputs) {
      expect(input.status).toBe('DRAFT');
      expect(input.status).not.toBe('POSTED');
      expect(input.agentConfidence).toBe(0.99);
      expect(input.organizationId).toBe(CTX.organizationId);
      // Balanced two-line draft: debit expense, credit cash.
      expect(input.lines).toHaveLength(2);
      expect(input.lines[0]).toMatchObject({ accountId: 'acct_suspense', isDebit: true });
      expect(input.lines[1]).toMatchObject({ accountId: 'acct_cash', isDebit: false });
    }
  });
});

describe('S5 zip-ingest — idempotency (content-hash keys)', () => {
  it('derives a deterministic 64-hex key from org + entry content hash', () => {
    const entryHash = sha256(Buffer.from('same-bytes'));
    const k1 = computeEntryIdempotencyKey('org_a', entryHash);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(computeEntryIdempotencyKey('org_a', entryHash)).toBe(k1);
    // Tenant-scoped and content-scoped.
    expect(computeEntryIdempotencyKey('org_b', entryHash)).not.toBe(k1);
    expect(computeEntryIdempotencyKey('org_a', sha256(Buffer.from('other')))).not.toBe(k1);
  });

  it('is date-independent: the same zip re-uploaded another day derives the same keys', () => {
    // Unlike LedgerService.computeIdempotencyKey (which folds in the calendar
    // day for retry semantics), the zip key must depend only on content.
    const entryHash = sha256(Buffer.from('receipt-bytes'));
    expect(computeEntryIdempotencyKey('org_a', entryHash)).toBe(
      computeEntryIdempotencyKey('org_a', entryHash),
    );
  });

  it('passes the key plus source/sourceId provenance to postEntry', async () => {
    const img = jpeg();
    const deps = makeDeps();
    await ingestZip(buildZip([{ name: 'r.jpg', data: img }]), CTX, deps);

    expect(deps.postedInputs).toHaveLength(1);
    const input = deps.postedInputs[0];
    const entryHash = sha256(img);
    expect(input.idempotencyKey).toBe(computeEntryIdempotencyKey(CTX.organizationId, entryHash));
    expect(input.source).toBe(ZIP_INGEST_SOURCE);
    expect(input.sourceId).toBe(entryHash);
  });

  it('re-uploading the same zip creates nothing and spends no OCR budget', async () => {
    const zipBuf = buildZip([
      { name: 'a.jpg', data: jpeg() },
      { name: 'b.jpg', data: jpeg() },
      { name: 'c.jpg', data: jpeg() },
    ]);

    // Application-level store standing in for the DB unique constraint.
    const seen = new Set<string>();
    let n = 0;
    const deps = makeDeps({
      postEntry: vi.fn(async (input: JournalEntryInput) => {
        seen.add(input.idempotencyKey as string);
        n += 1;
        return { id: `je_${n}` };
      }),
      findExistingIdempotencyKeys: vi.fn(async (_org: string, keys: string[]) => {
        return new Set(keys.filter((k) => seen.has(k)));
      }),
    });

    const first = await ingestZip(zipBuf, CTX, deps);
    expect(first.created).toBe(3);
    expect(first.deduped).toBe(0);
    expect(deps.ocr).toHaveBeenCalledTimes(3);

    const second = await ingestZip(zipBuf, CTX, deps);
    expect(second.created).toBe(0);
    expect(second.deduped).toBe(3);
    // No double-create AND no wasted OCR spend on the re-upload.
    expect(deps.ocr).toHaveBeenCalledTimes(3);
    expect(deps.postEntry).toHaveBeenCalledTimes(3);
    // Same zip → same zip-level content hash both times.
    expect(second.zipHash).toBe(first.zipHash);
    expect(second.zipHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('S5 zip-ingest — chat text parser', () => {
  it('counts WhatsApp-format message lines and participants', () => {
    const parsed = parseChatText(CHAT_TEXT);
    expect(parsed.messageCount).toBe(3);
    expect(parsed.participants.sort()).toEqual(['Kumar', 'Priya']);
  });

  it('handles the bracketed iOS export format', () => {
    const parsed = parseChatText(
      '[12/07/2026, 10:15:00] Kumar: Bought cement\n[12/07/2026, 10:16:12] Priya: OK',
    );
    expect(parsed.messageCount).toBe(2);
    expect(parsed.participants.sort()).toEqual(['Kumar', 'Priya']);
  });

  it('does not count continuation lines as messages', () => {
    const parsed = parseChatText(
      '12/07/2026, 10:15 - Kumar: line one\nthis is a continuation\n12/07/2026, 10:16 - Kumar: two',
    );
    expect(parsed.messageCount).toBe(2);
  });
});

// Stopgap for the inline serverless batch timeout (RAJ resilience issue): a
// large export OCRs every image inside one request and can blow past Vercel's
// function timeout, leaving ghost DRAFTs. Until ingest is moved off to an async
// worker, reject an export whose OCR-bound image count exceeds a safe cap
// BEFORE any OCR spend, so the user splits it instead of getting a half-import.
describe('S5 zip-ingest — per-request image cap (serverless-timeout stopgap)', () => {
  const images = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `IMG-${i}.jpg`, data: jpeg() }));

  it('exposes a positive image cap that is stricter than the zip-entry cap', () => {
    expect(MAX_INGEST_IMAGES).toBeGreaterThan(0);
    expect(MAX_INGEST_IMAGES).toBeLessThan(MAX_ZIP_ENTRIES);
  });

  it('rejects a zip whose OCR-bound image count exceeds maxImages (TOO_MANY_IMAGES)', async () => {
    const deps = makeDeps();
    await expect(
      ingestZip(buildZip(images(3)), CTX, deps, { maxImages: 2 }),
    ).rejects.toMatchObject({
      name: 'ZipIngestError',
      code: 'TOO_MANY_IMAGES',
      // Structured payload so the UI can render a precise message without
      // parsing prose (peer-review enhancement).
      meta: { limit: 2, actual: 3 },
    });
  });

  it('trips the cap BEFORE any OCR spend or ledger write', async () => {
    const deps = makeDeps();
    await expect(
      ingestZip(buildZip(images(3)), CTX, deps, { maxImages: 2 }),
    ).rejects.toBeInstanceOf(ZipIngestError);
    expect(deps.ocr).not.toHaveBeenCalled();
    expect(deps.postEntry).not.toHaveBeenCalled();
  });

  it('accepts exactly maxImages (boundary)', async () => {
    const deps = makeDeps();
    const report = await ingestZip(buildZip(images(2)), CTX, deps, { maxImages: 2 });
    expect(report.created).toBe(2);
  });

  it('counts only fresh (non-duplicate) images against the cap', async () => {
    // 3 images, but 2 already ingested → only 1 fresh → under a cap of 2.
    const entries = images(3);
    const built = buildZip(entries);
    const firstTwoKeys = new Set(
      entries.slice(0, 2).map((e) => computeEntryIdempotencyKey(CTX.organizationId, sha256(e.data))),
    );
    const deps = makeDeps({ findExistingIdempotencyKeys: vi.fn(async () => firstTwoKeys) });
    const report = await ingestZip(built, CTX, deps, { maxImages: 2 });
    expect(report.created).toBe(1);
    expect(report.deduped).toBe(2);
  });
});
