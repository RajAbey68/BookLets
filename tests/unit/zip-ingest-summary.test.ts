/**
 * Pure formatting logic for the zip-upload UI result banner. Kept separate
 * from the client component (which has no test harness — no RTL/jsdom in
 * this repo yet) so the actual decision logic is unit-testable.
 */
import { describe, it, expect } from 'vitest';
import { summarizeZipIngestReport } from '../../src/lib/zip-ingest-summary';
import type { ZipIngestReport } from '../../src/lib/zip-ingest';

function report(overrides: Partial<ZipIngestReport> = {}): ZipIngestReport {
  return {
    zipHash: 'abc123',
    totalEntries: 10,
    imageCount: 8,
    textCount: 2,
    skipped: [],
    created: 8,
    deduped: 0,
    failures: [],
    chatFiles: [],
    journalEntryIds: ['je_1', 'je_2'],
    ...overrides,
  };
}

describe('summarizeZipIngestReport', () => {
  it('reports full success with a count and a pointer to the review queue', () => {
    const result = summarizeZipIngestReport(report({ created: 3 }));
    expect(result.tone).toBe('success');
    expect(result.headline).toContain('3');
    expect(result.headline.toLowerCase()).toContain('draft');
  });

  it('is neutral (not success/error) when nothing new was created because everything deduped', () => {
    const result = summarizeZipIngestReport(report({ created: 0, deduped: 5 }));
    expect(result.tone).toBe('neutral');
    expect(result.headline.toLowerCase()).toContain('already');
  });

  it('is a warning when some images failed OCR or ledger posting, even if others succeeded', () => {
    const result = summarizeZipIngestReport(
      report({
        created: 2,
        failures: [{ name: 'r1.jpg', stage: 'ocr', error: 'timeout' }],
      }),
    );
    expect(result.tone).toBe('warning');
    expect(result.headline).toContain('2');
    expect(result.details.some((d) => d.includes('r1.jpg'))).toBe(true);
  });

  it('is an error when nothing was created and at least one entry failed', () => {
    const result = summarizeZipIngestReport(
      report({
        created: 0,
        deduped: 0,
        failures: [{ name: 'r1.jpg', stage: 'ledger', error: 'no accounts' }],
      }),
    );
    expect(result.tone).toBe('error');
  });

  it('lists skipped entries with their reason, capped so the banner never floods', () => {
    const skipped = Array.from({ length: 30 }, (_, i) => ({
      name: `file${i}.mp4`,
      reason: 'Disallowed type ".mp4"',
    }));
    const result = summarizeZipIngestReport(report({ skipped, created: 1 }));
    expect(result.details.length).toBeLessThanOrEqual(11); // 10 shown + 1 "+N more"
    expect(result.details[result.details.length - 1]).toMatch(/more/i);
  });

  it('surfaces chat transcript summaries as informational detail', () => {
    const result = summarizeZipIngestReport(
      report({
        chatFiles: [{ name: 'chat.txt', sha256: 'x', messageCount: 42, participants: ['A', 'B'] }],
      }),
    );
    expect(result.details.some((d) => d.includes('42'))).toBe(true);
  });
});
