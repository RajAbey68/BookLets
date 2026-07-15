/**
 * S1b — production wiring of the bridge (src/lib/ocr-bridge.deps.ts), focused
 * on the NO_FISCAL_PERIOD stranding fix (audit blocking finding #4).
 *
 * Production reality under test: the ledger has exactly ONE FiscalPeriod
 * (FY2026) while `raj_fin_track.ocr_receipts` holds rows whose doc_date falls
 * outside it. Before the fix those rows failed postEntry on every run AND
 * stayed counted in `remaining`, so the documented "re-invoke until
 * remaining: 0" loop never terminated. Now they must:
 *   - park as NO_FISCAL_PERIOD (detected via the same FiscalPeriod lookup
 *     LedgerService.checkFiscalPeriod performs — no date is ever fabricated
 *     or clamped, contract §7), creating NO JournalEntry;
 *   - be excluded from `remaining` by the SQL importable predicate, so a
 *     second invocation over an all-out-of-period pool reports remaining: 0.
 *
 * Mocked Prisma via vi.doMock in the style of journal-idempotency.test.ts —
 * no database. LedgerService is stubbed so any postEntry reach-through fails
 * the test loudly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OcrStagingRow } from '../../src/lib/ocr-bridge';

const ORG = 'org-bridge';

/** Staging rows dated 2024 — outside the sole FY2026 fiscal period. */
function outOfPeriodRows(): OcrStagingRow[] {
  return [1, 2].map((id) => ({
    id,
    source_file: `receipt-${id}.jpg`,
    doc_date: new Date(`2024-0${id}-15T00:00:00Z`),
    vendor_or_entity: 'Keells Super',
    total_amount: '4500.0000',
    currency: 'LKR',
    category: 'Groceries',
    raw_response: null,
    ocr_status: 'success',
  }));
}

/** A Prisma.sql fragment, duck-typed (Prisma.Sql is not constructable here). */
function isSqlFragment(v: unknown): v is { strings: string[]; values: unknown[] } {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as { strings?: unknown }).strings) &&
    Array.isArray((v as { values?: unknown }).values)
  );
}

/** Flatten a $queryRaw tagged-template call (nested Prisma.sql included) to text. */
function flattenSql(strings: readonly string[], values: readonly unknown[]): string {
  return strings.reduce((acc, s, i) => {
    if (i === 0) return s;
    const v = values[i - 1];
    const rendered = isSqlFragment(v) ? flattenSql(v.strings, v.values) : '?';
    return `${acc}${rendered}${s}`;
  }, '');
}

/**
 * Wire the module mocks: $queryRaw serves the staging batch (all rows out of
 * period) and answers the remaining-count query with 0 — which is what the
 * importable predicate yields in Postgres when no open FiscalPeriod covers
 * any staged doc_date. fiscalPeriod.findFirst finds no covering period.
 */
function setup() {
  const queryTexts: string[] = [];
  const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = flattenSql(strings, values);
    queryTexts.push(sql);
    if (sql.includes('count(*)')) return [{ n: 0 }];
    return outOfPeriodRows();
  });
  const fiscalFindFirst = vi.fn().mockResolvedValue(null); // sole period is FY2026
  vi.doMock('../../src/lib/prisma', () => ({
    prisma: { $queryRaw, fiscalPeriod: { findFirst: fiscalFindFirst } },
    setRlsOrgContext: vi.fn(),
  }));
  const postEntryWithOutcome = vi.fn(async () => {
    throw new Error('postEntry must never be reached for out-of-period rows');
  });
  vi.doMock('../../src/lib/ledger.service', () => ({
    LedgerService: { postEntryWithOutcome },
  }));
  return { queryTexts, fiscalFindFirst, postEntryWithOutcome };
}

beforeEach(() => vi.resetModules());

describe('runOcrBridgeImport — NO_FISCAL_PERIOD (audit blocking finding #4)', () => {
  it('parks out-of-period rows with NO_FISCAL_PERIOD and writes no JournalEntry', async () => {
    const { fiscalFindFirst, postEntryWithOutcome } = setup();
    const { runOcrBridgeImport } = await import('../../src/lib/ocr-bridge.deps');
    const summary = await runOcrBridgeImport(ORG);

    expect(summary.parked).toEqual([{ reason: 'NO_FISCAL_PERIOD', count: 2, ids: [1, 2] }]);
    expect(summary.parkedPermanently).toBe(2);
    expect(summary.posted).toBe(0);
    expect(summary.failed).toEqual([]); // parked with a reason, NOT failed
    expect(postEntryWithOutcome).not.toHaveBeenCalled();

    // Detection mirrors LedgerService.checkFiscalPeriod: open (not closed,
    // not locked) period of THIS org covering the doc_date.
    expect(fiscalFindFirst).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        startDate: { lte: new Date('2024-01-15T00:00:00Z') },
        endDate: { gte: new Date('2024-01-15T00:00:00Z') },
        isClosed: false,
        locked: false,
      },
      select: { id: true },
    });
  });

  it('returns remaining: 0 when everything left is permanently parked, so the loop terminates', async () => {
    setup();
    const { runOcrBridgeImport } = await import('../../src/lib/ocr-bridge.deps');

    // Second invocation over the same all-out-of-period pool — before the
    // fix this reported remaining > 0 forever (rows failed, never parked,
    // still counted), making "re-invoke until remaining: 0" non-terminating.
    const first = await runOcrBridgeImport(ORG);
    const second = await runOcrBridgeImport(ORG);
    expect(first.remaining).toBe(0);
    expect(second.remaining).toBe(0);
    expect(second.posted).toBe(0);
    expect(second.parked).toEqual([{ reason: 'NO_FISCAL_PERIOD', count: 2, ids: [1, 2] }]);
  });

  it('excludes rows without an open covering FiscalPeriod from BOTH the remaining count and the batch priority', async () => {
    const { queryTexts } = setup();
    const { runOcrBridgeImport } = await import('../../src/lib/ocr-bridge.deps');
    await runOcrBridgeImport(ORG);

    const [batchSql, countSql] = queryTexts;
    // Batch ordering demotes non-importable rows so they cannot starve the
    // window; the remaining count applies the same importable predicate.
    for (const sql of [batchSql, countSql]) {
      expect(sql).toContain('"FiscalPeriod"');
      expect(sql).toContain('"isClosed" = false');
      expect(sql).toContain('"locked" = false');
    }
    expect(batchSql).toContain('ORDER BY');
    expect(countSql).toContain('count(*)');
  });
});
