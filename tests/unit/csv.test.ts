/**
 * CSV cell escaping — including formula-injection defence for financial
 * exports (an account named "=SUM(...)" must not execute in Excel/Sheets).
 */
import { describe, it, expect } from 'vitest';
import { csvCell } from '../../src/lib/csv';

describe('csvCell', () => {
  it('quotes plain text', () => {
    expect(csvCell('Rental Income')).toBe('"Rental Income"');
  });

  it('escapes embedded double quotes', () => {
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
  });

  it('neutralizes formula-injection leads (= + - @) with a leading apostrophe', () => {
    expect(csvCell('=SUM(A1:A9)')).toBe('"\'=SUM(A1:A9)"');
    expect(csvCell('+1+1')).toBe('"\'+1+1"');
    expect(csvCell('-2+3')).toBe('"\'-2+3"');
    expect(csvCell('@cmd')).toBe('"\'@cmd"');
  });

  it('neutralizes tab/CR leads used to smuggle formulas', () => {
    expect(csvCell('\t=1')).toBe('"\'\t=1"');
  });

  it('handles empty and numeric-like input', () => {
    expect(csvCell('')).toBe('""');
    expect(csvCell(1250.5)).toBe('"1250.5"');
  });
});
