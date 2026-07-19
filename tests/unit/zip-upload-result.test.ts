import { describe, it, expect } from 'vitest';
import {
  summarizeZipUploadResponse,
  preflightZipFile,
  MAX_ZIP_BYTES,
} from '@/lib/zip-upload-result';
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
      error: 'Upload exceeds the 100 MB zip limit.',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('100 MB');
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

  it('rejects a file over the 100 MB cap without uploading it', () => {
    const result = preflightZipFile('huge.zip', MAX_ZIP_BYTES + 1);
    expect(result?.ok).toBe(false);
    expect(result?.message).toContain('100 MB');
  });
});
