/**
 * S6 review-ui — parseDraftEvidence is the single authority for turning an
 * automated entry's memo/source into displayable extraction evidence.
 * Pure function, no stubbing needed.
 */
import { describe, it, expect } from 'vitest';
import { parseDraftEvidence } from '../../src/lib/draft-evidence';

describe('parseDraftEvidence', () => {
  it('parses AutomationService receipt memos (vendor only)', () => {
    expect(parseDraftEvidence('AUTOMATED: Receipt for Colombo Hardware')).toEqual({
      origin: 'receipt-automation',
      vendor: 'Colombo Hardware',
      category: null,
      fileName: null,
    });
  });

  it('parses zip-ingest memos (vendor, category, filename)', () => {
    expect(
      parseDraftEvidence('ZIP-INGEST: Lanka Paints [Repairs & Maintenance] — receipts/r-014.jpg'),
    ).toEqual({
      origin: 'zip-ingest',
      vendor: 'Lanka Paints',
      category: 'Repairs & Maintenance',
      fileName: 'receipts/r-014.jpg',
    });
  });

  it('trusts structured source over a drifted memo', () => {
    const parsed = parseDraftEvidence('some rewritten memo', 'zip-ingest');
    expect(parsed.origin).toBe('zip-ingest');
    expect(parsed.vendor).toBeNull();
  });

  it('treats everything else as manual with no extracted fields', () => {
    for (const memo of [null, undefined, '', 'Revenue Recognition: Booking #42']) {
      const parsed = parseDraftEvidence(memo);
      expect(parsed.origin).toBe('manual');
      expect(parsed.vendor).toBeNull();
      expect(parsed.category).toBeNull();
      expect(parsed.fileName).toBeNull();
    }
  });
});
