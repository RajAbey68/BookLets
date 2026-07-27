/**
 * Statement upload card — pure render-model logic
 * (src/lib/statement-report-summary.ts).
 *
 * TDD RED-first suite. The upload card itself is dumb rendering (no component
 * test harness exists in this repo), so EVERY decision — tone, headline
 * wording, detail ordering, the reconciliation-mismatch sentence, list
 * capping — lives here where it is unit-testable.
 *
 * Tone rules:
 *   failures > 0                                → 'error'
 *   collisionWarnings > 0 OR reconciliation
 *     available-but-mismatched                  → 'warning'
 *   otherwise                                   → 'success'
 */
import { describe, it, expect } from 'vitest';
import {
  SUMMARY_DETAIL_CAP,
  summarizeStatementReport,
} from '../../src/lib/statement-report-summary';
import type { StatementIngestReport } from '../../src/lib/statement-ingest';

function makeReport(overrides: Partial<StatementIngestReport> = {}): StatementIngestReport {
  return {
    statementHash: 'a'.repeat(64),
    totalRows: 3,
    created: 2,
    deduped: 1,
    skipped: [],
    failures: [],
    collisionWarnings: [],
    reconciliation: null,
    inflowTotal: '10000.00',
    outflowTotal: '2500.50',
    ...overrides,
  };
}

describe('statement-report-summary — tone', () => {
  it('is success for a clean report', () => {
    expect(summarizeStatementReport(makeReport()).tone).toBe('success');
  });

  it('is success when reconciliation matched', () => {
    const summary = summarizeStatementReport(
      makeReport({
        reconciliation: {
          available: true,
          expectedDelta: '115500.00',
          parsedSum: '115500.00',
          matches: true,
        },
      }),
    );
    expect(summary.tone).toBe('success');
  });

  it('is warning when collision warnings exist', () => {
    const summary = summarizeStatementReport(
      makeReport({
        collisionWarnings: [{ row: 3, key: 'k', reason: 'Row 3 looked identical to row 2…' }],
      }),
    );
    expect(summary.tone).toBe('warning');
  });

  it('is warning when reconciliation is available but mismatched', () => {
    const summary = summarizeStatementReport(
      makeReport({
        reconciliation: {
          available: true,
          expectedDelta: '899999.00',
          parsedSum: '115500.00',
          matches: false,
        },
      }),
    );
    expect(summary.tone).toBe('warning');
  });

  it('is NOT warning when reconciliation could not run (available: false)', () => {
    const summary = summarizeStatementReport(
      makeReport({
        reconciliation: {
          available: false,
          expectedDelta: '0.00',
          parsedSum: '-30.00',
          matches: false,
        },
      }),
    );
    expect(summary.tone).toBe('success');
  });

  it('is error when failures exist — outranking every warning condition', () => {
    const summary = summarizeStatementReport(
      makeReport({
        failures: [{ row: 2, error: 'Unparseable date "garbage".' }],
        collisionWarnings: [{ row: 4, key: 'k', reason: 'collision' }],
        reconciliation: {
          available: true,
          expectedDelta: '1.00',
          parsedSum: '2.00',
          matches: false,
        },
      }),
    );
    expect(summary.tone).toBe('error');
  });
});

describe('statement-report-summary — headline', () => {
  it('reads counts in plain English', () => {
    const summary = summarizeStatementReport(
      makeReport({ created: 12, deduped: 3, skipped: [{ row: 2, reason: 'ZERO_AMOUNT' }] }),
    );
    expect(summary.headline).toBe('12 imported, 3 already in books, 1 skipped');
  });

  it('appends the failure count only when something failed', () => {
    const clean = summarizeStatementReport(makeReport({ created: 2, deduped: 1 }));
    expect(clean.headline).toBe('2 imported, 1 already in books, 0 skipped');

    const failed = summarizeStatementReport(
      makeReport({
        failures: [
          { row: 2, error: 'x' },
          { row: 3, error: 'y' },
        ],
      }),
    );
    expect(failed.headline).toBe('2 imported, 1 already in books, 0 skipped, 2 failed');
  });
});

describe('statement-report-summary — details', () => {
  it('renders the reconciliation mismatch prominently, first, in plain English', () => {
    const summary = summarizeStatementReport(
      makeReport({
        failures: [{ row: 2, error: 'boom' }],
        reconciliation: {
          available: true,
          expectedDelta: '899999.00',
          parsedSum: '115500.00',
          matches: false,
        },
      }),
    );
    expect(summary.details[0].tone).toBe('warning');
    expect(summary.details[0].text).toBe(
      "Balance check failed: statement's own balances imply 899999.00 but parsed rows sum to " +
        '115500.00 — do not trust this import until investigated.',
    );
  });

  it('omits the balance line when reconciliation matched or could not run', () => {
    const matched = summarizeStatementReport(
      makeReport({
        reconciliation: { available: true, expectedDelta: '1.00', parsedSum: '1.00', matches: true },
      }),
    );
    const unavailable = summarizeStatementReport(
      makeReport({
        reconciliation: { available: false, expectedDelta: '0.00', parsedSum: '1.00', matches: false },
      }),
    );
    for (const summary of [matched, unavailable]) {
      expect(summary.details.some((d) => d.text.includes('Balance check'))).toBe(false);
    }
  });

  it('renders failures as error lines with their row numbers', () => {
    const summary = summarizeStatementReport(
      makeReport({ failures: [{ row: 4, error: 'Unparseable amount "ten".' }] }),
    );
    const line = summary.details.find((d) => d.tone === 'error');
    expect(line?.text).toBe('Row 4 failed: Unparseable amount "ten".');
  });

  it('renders collision-warning reasons verbatim as warning lines', () => {
    const reason =
      'Row 3 looked identical to row 2 and was skipped — if these are genuinely two separate ' +
      'payments, they cannot be distinguished without a running-balance or transaction-ID ' +
      'column; fix the export.';
    const summary = summarizeStatementReport(
      makeReport({ collisionWarnings: [{ row: 3, key: 'k', reason }] }),
    );
    const line = summary.details.find((d) => d.tone === 'warning');
    expect(line?.text).toBe(reason);
  });

  it('renders skipped rows as info lines with plain-English reasons', () => {
    const summary = summarizeStatementReport(
      makeReport({
        skipped: [
          { row: 2, reason: 'ZERO_AMOUNT' },
          { row: 3, reason: 'FX_UNSUPPORTED' },
          { row: 4, reason: 'NO_FISCAL_PERIOD' },
        ],
      }),
    );
    const texts = summary.details.filter((d) => d.tone === 'info').map((d) => d.text);
    expect(texts[0]).toMatch(/^Row 2 skipped — /);
    // Raw reason codes never leak to Raj.
    for (const text of texts) {
      expect(text).not.toMatch(/ZERO_AMOUNT|FX_UNSUPPORTED|NO_FISCAL_PERIOD/);
    }
    expect(texts[1]).toMatch(/currency/i);
    expect(texts[2]).toMatch(/accounting year|fiscal|period/i);
  });

  it('never leaks an UNKNOWN skip code — plain-English fallback instead', () => {
    // parkReasonLabel echoes unknown codes back verbatim; the summary must
    // not inherit that behavior for a user-facing surface.
    const summary = summarizeStatementReport(
      makeReport({
        // Deliberately outside the StatementSkipReason union — the point is
        // exactly a code this version doesn't know about.
        skipped: [{ row: 2, reason: 'SOME_FUTURE_CODE' as never }],
      }),
    );
    const line = summary.details.find((d) => d.text.startsWith('Row 2'));
    expect(line).toBeDefined();
    expect(line!.text).not.toContain('SOME_FUTURE_CODE');
    expect(line!.text).toMatch(/unrecognised reason/);
  });

  it('orders details: balance line, failures, collisions, skips', () => {
    const summary = summarizeStatementReport(
      makeReport({
        skipped: [{ row: 5, reason: 'ZERO_AMOUNT' }],
        failures: [{ row: 2, error: 'boom' }],
        collisionWarnings: [{ row: 3, key: 'k', reason: 'collision reason' }],
        reconciliation: {
          available: true,
          expectedDelta: '1.00',
          parsedSum: '2.00',
          matches: false,
        },
      }),
    );
    expect(summary.details.map((d) => d.tone)).toEqual(['warning', 'error', 'warning', 'info']);
    expect(summary.details[1].text).toContain('Row 2 failed');
    expect(summary.details[2].text).toBe('collision reason');
    expect(summary.details[3].text).toContain('Row 5 skipped');
  });

  it('caps the list and reports how many lines were held back', () => {
    const skipped = Array.from({ length: SUMMARY_DETAIL_CAP + 4 }, (_, i) => ({
      row: i + 2,
      reason: 'ZERO_AMOUNT' as const,
    }));
    const summary = summarizeStatementReport(makeReport({ skipped }));
    expect(summary.details).toHaveLength(SUMMARY_DETAIL_CAP + 1);
    const overflow = summary.details[summary.details.length - 1];
    expect(overflow.tone).toBe('info');
    expect(overflow.text).toBe('…and 4 more not shown.');
  });

  it('never lets the cap displace the balance-check line', () => {
    const skipped = Array.from({ length: SUMMARY_DETAIL_CAP + 4 }, (_, i) => ({
      row: i + 2,
      reason: 'ZERO_AMOUNT' as const,
    }));
    const summary = summarizeStatementReport(
      makeReport({
        skipped,
        reconciliation: {
          available: true,
          expectedDelta: '1.00',
          parsedSum: '2.00',
          matches: false,
        },
      }),
    );
    expect(summary.details[0].text).toContain('Balance check failed');
    expect(summary.details).toHaveLength(SUMMARY_DETAIL_CAP + 1);
  });

  it('returns no details for a clean report', () => {
    expect(summarizeStatementReport(makeReport()).details).toEqual([]);
  });
});
