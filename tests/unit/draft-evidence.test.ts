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
      description: null,
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
      description: null,
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

/**
 * Statement rows carry the bank's own words. Before this was parsed, a bank
 * entry matched no memo format, fell through to `manual`, and every field came
 * back null — so the review screen showed "Vendor —" while the counterparty sat
 * in the memo, readable only in the audit trail. These are real memos from
 * production, not invented ones.
 */
describe('parseDraftEvidence — bank statement rows', () => {
  it('surfaces the counterparty from a payment memo', () => {
    expect(
      parseDraftEvidence('STATEMENT-INGEST: Sent money to B. A. T. Pansilu Bataduwa  (fee: 450.58 LKR)'),
    ).toEqual({
      origin: 'statement-ingest',
      vendor: null,
      category: null,
      fileName: null,
      description: 'Sent money to B. A. T. Pansilu Bataduwa  (fee: 450.58 LKR)',
    });
  });

  it('keeps a fee row pointing at the transfer it belongs to', () => {
    const parsed = parseDraftEvidence('STATEMENT-INGEST: Wise Charges for: TRANSFER-2281214695');
    expect(parsed.origin).toBe('statement-ingest');
    expect(parsed.description).toBe('Wise Charges for: TRANSFER-2281214695');
  });

  it('keeps an FX conversion, which has no counterparty at all', () => {
    const parsed = parseDraftEvidence('STATEMENT-INGEST: Converted 993.00 USD to 331,970.93 LKR');
    expect(parsed.description).toBe('Converted 993.00 USD to 331,970.93 LKR');
    // Deliberately not a vendor: there is no one to name here.
    expect(parsed.vendor).toBeNull();
  });

  it('does not pass the importer placeholder off as a description', () => {
    const parsed = parseDraftEvidence('STATEMENT-INGEST: (no description)');
    expect(parsed.origin).toBe('statement-ingest');
    expect(parsed.description).toBeNull();
  });

  it('falls back to structured provenance when the memo has been rewritten', () => {
    const parsed = parseDraftEvidence('edited by hand', 'STATEMENT_INGEST');
    expect(parsed.origin).toBe('statement-ingest');
    expect(parsed.description).toBeNull();
  });
});
