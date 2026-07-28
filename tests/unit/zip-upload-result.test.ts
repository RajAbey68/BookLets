import { describe, it, expect } from 'vitest';
import {
  summarizeZipUploadResponse,
  preflightZipFile,
  MAX_ZIP_BYTES,
  describeProgress,
  splitNdjson,
} from '@/lib/zip-upload-result';
import { MAX_DIRECT_UPLOAD_BYTES, OVERSIZE_UPLOAD_HELP } from '@/lib/upload-limits';
import type { ZipIngestReport } from '@/lib/zip-ingest';

/**
 * The WhatsApp-zip upload control POSTs to /api/ingest/zip and must turn the
 * raw HTTP status + JSON body into a single, non-technical result the operator
 * can act on. That mapping is the logic worth testing (the React component is
 * thin glue over it and runs in a node-only test env with no DOM).
 */

function report(overrides: Partial<ZipIngestReport> = {}): ZipIngestReport {
  return {
    zipHash: 'abc123',
    totalEntries: 10,
    imageCount: 6,
    textCount: 1,
    skipped: [],
    created: 0,
    deduped: 0,
    failures: [],
    chatFiles: [],
    journalEntryIds: [],
    ...overrides,
  };
}

describe('summarizeZipUploadResponse', () => {
  it('summarizes a successful import with created, deduped and skipped counts', () => {
    // Arrange
    const body = {
      report: report({
        created: 12,
        deduped: 3,
        skipped: [
          { name: 'note.pdf', reason: 'disallowed type' },
          { name: 'video.mp4', reason: 'disallowed type' },
        ],
        journalEntryIds: Array.from({ length: 12 }, (_, i) => `je_${i}`),
      }),
    };

    // Act
    const result = summarizeZipUploadResponse(200, body);

    // Assert
    expect(result.ok).toBe(true);
    expect(result.created).toBe(12);
    expect(result.deduped).toBe(3);
    expect(result.skipped).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.showReviewLink).toBe(true);
    expect(result.message).toContain('12');
  });

  it('flags "nothing new" when every entry was a duplicate', () => {
    const body = { report: report({ created: 0, deduped: 5 }) };

    const result = summarizeZipUploadResponse(200, body);

    expect(result.ok).toBe(true);
    expect(result.created).toBe(0);
    expect(result.deduped).toBe(5);
    expect(result.showReviewLink).toBe(false);
    expect(result.message.toLowerCase()).toMatch(/duplicate|nothing new|already/);
  });

  it('counts failures reported by the ingest pipeline', () => {
    const body = {
      report: report({
        created: 4,
        failures: [{ name: 'IMG-9.jpg', stage: 'ocr', error: 'ocr timeout' }],
        journalEntryIds: ['a', 'b', 'c', 'd'],
      }),
    };

    const result = summarizeZipUploadResponse(200, body);

    expect(result.ok).toBe(true);
    expect(result.failed).toBe(1);
  });

  it('maps 413 to a file-too-large result and surfaces the server limit text', () => {
    const result = summarizeZipUploadResponse(413, {
      error: 'Upload exceeds the 4 MB zip limit.',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('4 MB');
  });

  /**
   * The incident. Vercel's edge answers an oversized body with
   * `413 FUNCTION_PAYLOAD_TOO_LARGE` in a PLAIN-TEXT body, before the route
   * runs — so `res.json()` throws and the caller passes whatever it managed
   * to salvage. Every one of these shapes must still render a clear,
   * actionable error, never a blank and never something that looks like
   * progress.
   */
  describe('413 from the platform edge (plain-text body, not JSON)', () => {
    const NON_JSON_BODIES: [string, unknown][] = [
      ['res.json() threw, caller kept its `{}` default', {}],
      ['caller passed the raw text', 'Request Entity Too Large\nFUNCTION_PAYLOAD_TOO_LARGE'],
      ['caller passed nothing', undefined],
      ['res.json() resolved to JSON null', null],
      ['an HTML error page was parsed away to an array', []],
    ];

    it.each(NON_JSON_BODIES)('degrades cleanly when %s', (_label, body) => {
      const result = summarizeZipUploadResponse(413, body);

      expect(result.ok).toBe(false);
      expect(result.title.toLowerCase()).toContain('large');
      expect(result.message.length).toBeGreaterThan(0);
      // The honest limit, and the workaround — not the 100 MB fiction.
      expect(result.message).not.toContain('100 MB');
      expect(result.message).toContain(OVERSIZE_UPLOAD_HELP);
    });

    it('never leaks the platform\'s raw plain-text body to the operator', () => {
      const result = summarizeZipUploadResponse(413, 'FUNCTION_PAYLOAD_TOO_LARGE');
      expect(result.message).not.toContain('FUNCTION_PAYLOAD_TOO_LARGE');
    });
  });

  it('degrades cleanly on a non-JSON 500 (proxy/HTML error page)', () => {
    const result = summarizeZipUploadResponse(500, '<html>502 Bad Gateway</html>');
    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.message).not.toContain('<html>');
  });

  it('maps 400 (empty / not a zip / missing file) to an invalid-file result', () => {
    const result = summarizeZipUploadResponse(400, { error: 'Empty upload.' });

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('maps 422 guard rejections (zip bomb / too many entries) to a rejection', () => {
    const result = summarizeZipUploadResponse(422, {
      error: 'Archive has too many entries.',
      code: 'TOO_MANY_ENTRIES',
    });

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('maps 401 to a session-expired result', () => {
    const result = summarizeZipUploadResponse(401, { error: 'unauthorized' });

    expect(result.ok).toBe(false);
    expect(result.title.toLowerCase()).toMatch(/sign|session/);
  });

  it('maps 403 to a role/permission result (shared by both uploaders)', () => {
    const result = summarizeZipUploadResponse(403, {});

    expect(result.ok).toBe(false);
    expect(result.message.toLowerCase()).toMatch(/role|allowed|permission/);
  });

  it('maps 500 and unknown statuses to a generic failure', () => {
    const result = summarizeZipUploadResponse(500, { error: 'Zip ingestion failed.' });

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe('preflightZipFile', () => {
  it('accepts a normal .zip under the size cap (returns null = ok to upload)', () => {
    expect(preflightZipFile('WhatsApp Chat - Petty Cash.zip', 2 * 1024 * 1024)).toBeNull();
  });

  it('rejects a non-zip file before any upload happens', () => {
    const result = preflightZipFile('receipt.pdf', 1000);
    expect(result?.ok).toBe(false);
    expect(result?.title.toLowerCase()).toContain('zip');
  });

  it('rejects an empty file', () => {
    const result = preflightZipFile('export.zip', 0);
    expect(result?.ok).toBe(false);
  });

  it('rejects a file over the real platform ceiling without uploading it', () => {
    const result = preflightZipFile('huge.zip', MAX_DIRECT_UPLOAD_BYTES + 1);
    expect(result?.ok).toBe(false);
    expect(result?.message).toContain('4 MB');
    expect(result?.message).toContain(OVERSIZE_UPLOAD_HELP);
  });

  /**
   * The exact regression: a 62 MB WhatsApp "Attach Media" export passed the
   * old 100 MB preflight, was uploaded, and died at the edge with no error
   * ever reaching the UI. It must now be rejected instantly, in the browser.
   */
  it('rejects the 62 MB export that silently died at the edge in production', () => {
    const result = preflightZipFile('WhatsApp Chat - Ko Lake Petty Cash.zip', 62_411_000);
    expect(result?.ok).toBe(false);
    expect(result?.message).toContain('59.5 MB');
    expect(result?.message).not.toContain('100 MB');
  });

  it('accepts a file exactly at the ceiling (boundary)', () => {
    expect(preflightZipFile('edge.zip', MAX_DIRECT_UPLOAD_BYTES)).toBeNull();
  });

  it('keeps MAX_ZIP_BYTES as an alias of the single shared ceiling', () => {
    expect(MAX_ZIP_BYTES).toBe(MAX_DIRECT_UPLOAD_BYTES);
  });
});

describe('describeProgress — number-by-number line (no spinner)', () => {
  it('renders done/total/name plus running created and failed', () => {
    expect(
      describeProgress({ done: 12, total: 40, name: 'IMG-12.jpg', created: 9, failed: 3 }),
    ).toBe('Processing 12 of 40 — IMG-12.jpg · 9 created · 3 need review');
  });
  it('omits zero counts', () => {
    expect(describeProgress({ done: 1, total: 5, name: 'a.jpg', created: 1, failed: 0 })).toBe(
      'Processing 1 of 5 — a.jpg · 1 created',
    );
  });
});

describe('splitNdjson — stream line accumulator', () => {
  it('parses complete lines and keeps a partial remainder for the next chunk', () => {
    const { events, rest } = splitNdjson('{"type":"progress","done":1}\n{"type":"done"}\n{"partial":');
    expect(events).toEqual([{ type: 'progress', done: 1 }, { type: 'done' }]);
    expect(rest).toBe('{"partial":');
  });
  it('returns no events when the buffer has only a partial line', () => {
    const { events, rest } = splitNdjson('{"type":"pro');
    expect(events).toEqual([]);
    expect(rest).toBe('{"type":"pro');
  });
});

describe('summarizeZipUploadResponse — explicit counts (owner: "how many did it see?")', () => {
  it('states receipts SEEN and surfaces the reason when a receipt cannot be read', () => {
    const body = {
      report: report({
        imageCount: 1,
        created: 0,
        deduped: 0,
        failures: [{ name: 'r.jpg', stage: 'ocr', error: 'Gemini OCR: GEMINI_API_KEY is not set' }],
        skipped: [{ name: 'x.vcf', reason: 'contact card' }],
      }),
    };
    const res = summarizeZipUploadResponse(200, body);
    expect(res.seen).toBe(1);
    expect(res.ok).toBe(false); // receipts found but none imported → surfaced as a problem, not a bland "nothing new"
    expect(res.message).toContain('Saw 1 receipt');
    expect(res.message).toContain('0 imported');
    expect(res.message).toContain('OCR service');
    expect(res.message).toContain('1 non-receipt file skipped');
  });

  it('distinguishes "already in your books" from new and failed', () => {
    const body = { report: report({ imageCount: 3, created: 1, deduped: 2, failures: [], skipped: [] }) };
    const res = summarizeZipUploadResponse(200, body);
    expect(res.seen).toBe(3);
    expect(res.ok).toBe(true);
    expect(res.message).toContain('Saw 3 receipts');
    expect(res.message).toContain('1 imported');
    expect(res.message).toContain('2 already in your books');
  });

  it('says NO receipts found when the archive is chat-text only', () => {
    const body = { report: report({ imageCount: 0, created: 0, deduped: 0, failures: [], skipped: [] }) };
    const res = summarizeZipUploadResponse(200, body);
    expect(res.seen).toBe(0);
    expect(res.title.toLowerCase()).toContain('no receipts');
    expect(res.message.toLowerCase()).toMatch(/chat text|attach media/);
  });
});
