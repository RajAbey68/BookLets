/**
 * Bank-statement CSV importer (contract: docs/runs/STATEMENT-INGEST-CONTRACT.md).
 *
 * TDD RED-first suite. Drives src/lib/statement-ingest.ts, a pure core module
 * (no prisma/network imports) with injectable deps so no live DB is touched:
 *
 *   - CSV parsing (quoted fields with embedded commas/newlines/quotes, CRLF).
 *   - Header detection: Wise export format auto-detected; generic mapping
 *     needs at least Date/Amount/Description (case-insensitive).
 *   - Per-row natural key: bank transaction ID when present, else a sha256
 *     over date|amount|currency|normalizedDescription|runningBalance.
 *   - Idempotency key sha256("stmt-ingest" NUL org NUL naturalKey) — enforced
 *     by the EXISTING JournalEntry (organizationId, idempotencyKey) unique
 *     index; no migration.
 *   - Dedup layers: in-file collapse + findExistingIdempotencyKeys pre-check
 *     (the DB constraint backstops races); both count into `deduped`.
 *   - Skips: ZERO_AMOUNT, FX_UNSUPPORTED (LKR-only books), NO_FISCAL_PERIOD
 *     (dates are never clamped/fabricated). Parse failures land in failures[].
 *   - Money is decimal.js end-to-end — never Number.
 *   - Every entry DRAFT, maker = AUTOMATION_MAKER_IDENTITY.
 */
import { describe, it, expect, vi } from 'vitest';
import { Decimal } from 'decimal.js';
import { createHash } from 'node:crypto';
import {
  MAX_STATEMENT_UPLOAD_BYTES,
  MAX_STATEMENT_ROWS,
  STATEMENT_INGEST_SOURCE,
  STATEMENT_INGEST_JOURNAL_STATUS,
  StatementIngestError,
  parseCsv,
  detectColumns,
  normalizeDescription,
  computeNaturalKey,
  computeStatementIdempotencyKey,
  computeStatementHash,
  ingestStatement,
  type StatementIngestDeps,
} from '../../src/lib/statement-ingest';
import { AUTOMATION_MAKER_IDENTITY } from '../../src/lib/maker-identity';
import type { JournalEntryInput } from '../../src/lib/types';

// ─── fixtures ─────────────────────────────────────────────────────────────────

const CTX = { organizationId: 'org_test_1', userId: 'user_test_1' };

const WISE_CSV = [
  '"TransferWise ID",Date,Amount,Currency,Description,"Running Balance"',
  'TRANSFER-1001,01-07-2026,-4500.00,LKR,"Cement purchase, hardware store",95500.00',
  'TRANSFER-1002,02-07-2026,120000.00,LKR,Booking payout,215500.00',
].join('\n');

const GENERIC_CSV = [
  'date,description,amount',
  '2026-07-03,Utility bill,-2500.50',
  '2026-07-04,Guest deposit,10000.00',
].join('\r\n');

function buf(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ─── deps harness ─────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<StatementIngestDeps> = {}): StatementIngestDeps & {
  postedInputs: JournalEntryInput[];
} {
  const postedInputs: JournalEntryInput[] = [];
  let n = 0;
  const deps: StatementIngestDeps = {
    postEntry: vi.fn(async (input: JournalEntryInput) => {
      postedInputs.push(input);
      n += 1;
      return { id: `je_${n}` };
    }),
    findExistingIdempotencyKeys: vi.fn(async () => new Set<string>()),
    resolveStatementAccounts: vi.fn(async () => ({
      bankAccountId: 'acct_bank',
      suspenseAccountId: 'acct_suspense',
    })),
    hasOpenFiscalPeriod: vi.fn(async () => true),
    recordEvidence: vi.fn(async () => {}),
    ...overrides,
  };
  return Object.assign(deps, { postedInputs });
}

/**
 * Deps whose "database" persists idempotency keys across runs — stands in for
 * the JournalEntry unique index when testing re-upload / overlap dedup.
 */
function makePersistentDeps() {
  const seen = new Set<string>();
  const deps = makeDeps();
  const record = deps.postEntry;
  deps.postEntry = vi.fn(async (input: JournalEntryInput) => {
    seen.add(input.idempotencyKey as string);
    return record(input);
  });
  deps.findExistingIdempotencyKeys = vi.fn(async (_org: string, keys: string[]) => {
    return new Set(keys.filter((k) => seen.has(k)));
  });
  return deps;
}

// ─── guard constants ──────────────────────────────────────────────────────────

describe('statement-ingest — guard constants', () => {
  it('caps the upload at 5 MB', () => {
    expect(MAX_STATEMENT_UPLOAD_BYTES).toBe(5 * 1024 * 1024);
  });

  it('caps a statement at 10,000 data rows', () => {
    expect(MAX_STATEMENT_ROWS).toBe(10_000);
  });

  it('pins the journal status for statement entries to DRAFT', () => {
    expect(STATEMENT_INGEST_JOURNAL_STATUS).toBe('DRAFT');
  });

  it('pins the provenance source marker', () => {
    expect(STATEMENT_INGEST_SOURCE).toBe('STATEMENT_INGEST');
  });
});

// ─── CSV parser ───────────────────────────────────────────────────────────────

describe('statement-ingest — CSV parser', () => {
  it('parses plain comma-separated rows', () => {
    expect(parseCsv('a,b,c\nd,e,f')).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
    ]);
  });

  it('keeps commas inside quoted fields', () => {
    expect(parseCsv('a,"b, with comma",c')).toEqual([['a', 'b, with comma', 'c']]);
  });

  it('keeps newlines inside quoted fields', () => {
    expect(parseCsv('a,"line one\nline two",c\nd,e,f')).toEqual([
      ['a', 'line one\nline two', 'c'],
      ['d', 'e', 'f'],
    ]);
  });

  it('unescapes doubled quotes inside quoted fields', () => {
    expect(parseCsv('a,"he said ""pay now""",c')).toEqual([['a', 'he said "pay now"', 'c']]);
  });

  it('handles CRLF line endings and a trailing newline', () => {
    expect(parseCsv('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('drops rows that are entirely empty', () => {
    expect(parseCsv('a,b\n\n , \nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('rejects an unterminated quoted field (INVALID_CSV)', () => {
    try {
      parseCsv('a,"unterminated\nb,c');
      expect.unreachable('expected INVALID_CSV');
    } catch (err) {
      expect(err).toBeInstanceOf(StatementIngestError);
      expect((err as StatementIngestError).code).toBe('INVALID_CSV');
    }
  });
});

// ─── header detection ─────────────────────────────────────────────────────────

describe('statement-ingest — header detection', () => {
  it('auto-detects the Wise export format', () => {
    const columns = detectColumns([
      'TransferWise ID',
      'Date',
      'Amount',
      'Currency',
      'Description',
      'Running Balance',
    ]);
    expect(columns.format).toBe('wise');
    expect(columns.id).toBe(0);
    expect(columns.date).toBe(1);
    expect(columns.amount).toBe(2);
    expect(columns.currency).toBe(3);
    expect(columns.description).toBe(4);
    expect(columns.runningBalance).toBe(5);
  });

  it('detects Wise with a bare "ID" column too', () => {
    const columns = detectColumns([
      'ID',
      'Date',
      'Amount',
      'Currency',
      'Description',
      'Running Balance',
    ]);
    expect(columns.format).toBe('wise');
    expect(columns.id).toBe(0);
  });

  it('maps a generic export case-insensitively with optional columns absent', () => {
    const columns = detectColumns(['DATE', 'description', 'Amount']);
    expect(columns.format).toBe('generic');
    expect(columns.date).toBe(0);
    expect(columns.description).toBe(1);
    expect(columns.amount).toBe(2);
    expect(columns.id).toBeNull();
    expect(columns.currency).toBeNull();
    expect(columns.runningBalance).toBeNull();
  });

  it('picks up optional Currency / Running Balance / ID columns in generic mode', () => {
    const columns = detectColumns(['Transaction ID', 'Date', 'Description', 'Amount', 'Currency']);
    expect(columns.format).toBe('generic');
    expect(columns.id).toBe(0);
    expect(columns.currency).toBe(4);
  });

  it('rejects a header missing Date/Amount/Description (MISSING_COLUMNS)', () => {
    try {
      detectColumns(['Foo', 'Bar', 'Baz']);
      expect.unreachable('expected MISSING_COLUMNS');
    } catch (err) {
      expect(err).toBeInstanceOf(StatementIngestError);
      expect((err as StatementIngestError).code).toBe('MISSING_COLUMNS');
    }
  });

  it('tolerates a UTF-8 BOM on the first header cell', () => {
    const columns = detectColumns(['﻿Date', 'Description', 'Amount']);
    expect(columns.date).toBe(0);
  });
});

// ─── natural key ──────────────────────────────────────────────────────────────

describe('statement-ingest — natural key', () => {
  const HASH_PARTS = {
    bankTransactionId: null,
    dateIso: '2026-07-01',
    amount: '-4500',
    currency: 'LKR',
    description: 'Cement purchase',
    runningBalance: '95500.00',
  };

  it('normalizes descriptions: trim, collapse whitespace, lowercase', () => {
    expect(normalizeDescription('  Cement   PURCHASE \t x ')).toBe('cement purchase x');
  });

  it('prefers a non-empty bank transaction ID over the hash key', () => {
    expect(computeNaturalKey({ ...HASH_PARTS, bankTransactionId: 'TRANSFER-1001' })).toBe(
      'TRANSFER-1001',
    );
  });

  it('falls back to the hash key when the bank ID is empty or whitespace', () => {
    expect(computeNaturalKey({ ...HASH_PARTS, bankTransactionId: '   ' })).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(computeNaturalKey(HASH_PARTS)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hash key is stable for the same row', () => {
    expect(computeNaturalKey(HASH_PARTS)).toBe(computeNaturalKey({ ...HASH_PARTS }));
  });

  it('hash key ignores description whitespace/case differences (normalization)', () => {
    expect(computeNaturalKey({ ...HASH_PARTS, description: '  CEMENT   purchase ' })).toBe(
      computeNaturalKey(HASH_PARTS),
    );
  });

  it('hash key differs when any field differs', () => {
    const base = computeNaturalKey(HASH_PARTS);
    expect(computeNaturalKey({ ...HASH_PARTS, amount: '-4501' })).not.toBe(base);
    expect(computeNaturalKey({ ...HASH_PARTS, dateIso: '2026-07-02' })).not.toBe(base);
    expect(computeNaturalKey({ ...HASH_PARTS, description: 'other vendor' })).not.toBe(base);
    expect(computeNaturalKey({ ...HASH_PARTS, runningBalance: '91000.00' })).not.toBe(base);
  });
});

// ─── idempotency key ──────────────────────────────────────────────────────────

describe('statement-ingest — idempotency key', () => {
  it('is sha256("stmt-ingest" NUL org NUL naturalKey) — same construction as zip-ingest', () => {
    const expected = createHash('sha256')
      .update(['stmt-ingest', 'org_a', 'TRANSFER-1'].join('\u0000'))
      .digest('hex');
    expect(computeStatementIdempotencyKey('org_a', 'TRANSFER-1')).toBe(expected);
  });

  it('is deterministic, tenant-scoped and key-scoped', () => {
    const k1 = computeStatementIdempotencyKey('org_a', 'nk-1');
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(computeStatementIdempotencyKey('org_a', 'nk-1')).toBe(k1);
    expect(computeStatementIdempotencyKey('org_b', 'nk-1')).not.toBe(k1);
    expect(computeStatementIdempotencyKey('org_a', 'nk-2')).not.toBe(k1);
  });
});

// ─── Wise-format ingest ───────────────────────────────────────────────────────

describe('statement-ingest — Wise format', () => {
  it('creates one DRAFT entry per row with bank-ID keys and provenance', async () => {
    const deps = makeDeps();
    const report = await ingestStatement(buf(WISE_CSV), CTX, deps);

    expect(report.totalRows).toBe(2);
    expect(report.created).toBe(2);
    expect(report.deduped).toBe(0);
    expect(report.skipped).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.statementHash).toBe(computeStatementHash(buf(WISE_CSV)));
    expect(report.statementHash).toBe(sha256(WISE_CSV));

    expect(deps.postedInputs).toHaveLength(2);
    for (const input of deps.postedInputs) {
      expect(input.status).toBe('DRAFT');
      expect(input.makerIdentity).toBe(AUTOMATION_MAKER_IDENTITY);
      expect(input.source).toBe(STATEMENT_INGEST_SOURCE);
      expect(input.organizationId).toBe(CTX.organizationId);
      expect(input.tenantId).toBe(CTX.organizationId);
      // Statements carry no extraction confidence — explicit NULL, not a number.
      expect(input.agentConfidence).toBeNull();
    }
    // Bank transaction ID is the natural key → sourceId and the key input.
    expect(deps.postedInputs[0].sourceId).toBe('TRANSFER-1001');
    expect(deps.postedInputs[0].idempotencyKey).toBe(
      computeStatementIdempotencyKey(CTX.organizationId, 'TRANSFER-1001'),
    );
    expect(deps.postedInputs[1].sourceId).toBe('TRANSFER-1002');
  });

  it('books an outflow as debit Suspense / credit Bank at the absolute amount', async () => {
    const deps = makeDeps();
    await ingestStatement(buf(WISE_CSV), CTX, deps);

    const outflow = deps.postedInputs[0]; // -4500.00
    expect(outflow.lines).toHaveLength(2);
    expect(outflow.lines[0]).toMatchObject({ accountId: 'acct_suspense', isDebit: true });
    expect(outflow.lines[1]).toMatchObject({ accountId: 'acct_bank', isDebit: false });
    for (const line of outflow.lines) {
      expect(new Decimal(line.amount.toString()).toFixed(2)).toBe('4500.00');
      expect(line.currency).toBe('LKR');
    }
  });

  it('books an inflow as debit Bank / credit Suspense', async () => {
    const deps = makeDeps();
    await ingestStatement(buf(WISE_CSV), CTX, deps);

    const inflow = deps.postedInputs[1]; // +120000.00
    expect(inflow.lines[0]).toMatchObject({ accountId: 'acct_bank', isDebit: true });
    expect(inflow.lines[1]).toMatchObject({ accountId: 'acct_suspense', isDebit: false });
    expect(new Decimal(inflow.lines[0].amount.toString()).toFixed(2)).toBe('120000.00');
  });

  it('parses Wise day-first dates into UTC entry dates', async () => {
    const deps = makeDeps();
    await ingestStatement(buf(WISE_CSV), CTX, deps);
    expect((deps.postedInputs[0].date as Date).toISOString().slice(0, 10)).toBe('2026-07-01');
    expect((deps.postedInputs[1].date as Date).toISOString().slice(0, 10)).toBe('2026-07-02');
  });

  it('reports inflow/outflow totals as 2dp strings', async () => {
    const deps = makeDeps();
    const report = await ingestStatement(buf(WISE_CSV), CTX, deps);
    expect(report.inflowTotal).toBe('120000.00');
    expect(report.outflowTotal).toBe('4500.00');
  });
});

// ─── generic-format ingest ────────────────────────────────────────────────────

describe('statement-ingest — generic format', () => {
  it('ingests a Date/Description/Amount export (no ID → hash natural keys)', async () => {
    const deps = makeDeps();
    const report = await ingestStatement(buf(GENERIC_CSV), CTX, deps);

    expect(report.created).toBe(2);
    expect(report.failures).toEqual([]);
    // No bank ID column → the natural key (and sourceId) is the row hash.
    for (const input of deps.postedInputs) {
      expect(input.sourceId).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(report.inflowTotal).toBe('10000.00');
    expect(report.outflowTotal).toBe('2500.50');
  });

  it('assumes LKR when the export has no Currency column (LKR-only books)', async () => {
    const deps = makeDeps();
    const report = await ingestStatement(buf(GENERIC_CSV), CTX, deps);
    expect(report.skipped).toEqual([]);
    expect(deps.postedInputs[0].lines[0].currency).toBe('LKR');
  });

  it('parses quoted descriptions with embedded commas and quotes', async () => {
    const csv = ['Date,Description,Amount', '2026-07-05,"Transfer, ref ""ABC-1""",-99.99'].join(
      '\n',
    );
    const deps = makeDeps();
    const report = await ingestStatement(buf(csv), CTX, deps);
    expect(report.created).toBe(1);
    expect(deps.postedInputs[0].memo).toContain('Transfer, ref "ABC-1"');
  });

  it('accepts a header-only file as an empty (0-row) statement', async () => {
    const deps = makeDeps();
    const report = await ingestStatement(buf('Date,Description,Amount'), CTX, deps);
    expect(report.totalRows).toBe(0);
    expect(report.created).toBe(0);
    expect(deps.postEntry).not.toHaveBeenCalled();
  });
});

// ─── dedup layers ─────────────────────────────────────────────────────────────

describe('statement-ingest — dedup layers', () => {
  it('re-uploading the identical file creates 0 and dedupes all rows', async () => {
    const deps = makePersistentDeps();

    const first = await ingestStatement(buf(WISE_CSV), CTX, deps);
    expect(first.created).toBe(2);
    expect(first.deduped).toBe(0);

    const second = await ingestStatement(buf(WISE_CSV), CTX, deps);
    expect(second.created).toBe(0);
    expect(second.deduped).toBe(2);
    expect(second.failures).toEqual([]);
    expect(deps.postEntry).toHaveBeenCalledTimes(2);
    expect(second.statementHash).toBe(first.statementHash);
  });

  it('an overlapping file creates only the rows not already ingested', async () => {
    const deps = makePersistentDeps();
    await ingestStatement(buf(WISE_CSV), CTX, deps);

    const overlapping = [
      '"TransferWise ID",Date,Amount,Currency,Description,"Running Balance"',
      'TRANSFER-1002,02-07-2026,120000.00,LKR,Booking payout,215500.00',
      'TRANSFER-1003,03-07-2026,-800.00,LKR,Bank fee,214700.00',
    ].join('\n');
    const report = await ingestStatement(buf(overlapping), CTX, deps);
    expect(report.created).toBe(1);
    expect(report.deduped).toBe(1);
    expect(deps.postedInputs.map((i) => i.sourceId)).toEqual([
      'TRANSFER-1001',
      'TRANSFER-1002',
      'TRANSFER-1003',
    ]);
  });

  it('collapses the same transaction appearing twice within one file', async () => {
    const csv = [
      '"TransferWise ID",Date,Amount,Currency,Description,"Running Balance"',
      'TRANSFER-1001,01-07-2026,-4500.00,LKR,Cement,95500.00',
      'TRANSFER-1001,01-07-2026,-4500.00,LKR,Cement,95500.00',
    ].join('\n');
    const deps = makeDeps();
    const report = await ingestStatement(buf(csv), CTX, deps);
    expect(report.created).toBe(1);
    expect(report.deduped).toBe(1);
    expect(deps.postEntry).toHaveBeenCalledTimes(1);
  });

  it('a postEntry unique-constraint race lands in failures, not a double-create', async () => {
    // Layers (a)+(b) missed the race loser; the DB unique index throws inside
    // postEntry. The row must surface as a failure — never a second entry.
    const deps = makeDeps({
      postEntry: vi.fn(async () => {
        throw new Error('Unique constraint failed on (organizationId, idempotencyKey)');
      }),
    });
    const report = await ingestStatement(buf(GENERIC_CSV), CTX, deps);
    expect(report.created).toBe(0);
    expect(report.failures).toHaveLength(2);
    expect(report.failures[0].error).toMatch(/Unique constraint/);
  });
});

// ─── skips and failures ───────────────────────────────────────────────────────

describe('statement-ingest — skips and failures', () => {
  it('skips zero-amount rows with a reason', async () => {
    const csv = [
      'Date,Description,Amount',
      '2026-07-01,Zero-value notification,0.00',
      '2026-07-02,Real charge,-10.00',
    ].join('\n');
    const deps = makeDeps();
    const report = await ingestStatement(buf(csv), CTX, deps);
    expect(report.created).toBe(1);
    // Row numbers are spreadsheet-style: header is row 1.
    expect(report.skipped).toEqual([{ row: 2, reason: 'ZERO_AMOUNT' }]);
  });

  it('skips non-LKR rows as FX_UNSUPPORTED (LKR-only books, ocr-bridge policy)', async () => {
    const csv = [
      'Date,Description,Amount,Currency',
      '2026-07-01,GBP transfer,-100.00,GBP',
      '2026-07-02,Local charge,-10.00,LKR',
    ].join('\n');
    const deps = makeDeps();
    const report = await ingestStatement(buf(csv), CTX, deps);
    expect(report.created).toBe(1);
    expect(report.skipped).toEqual([{ row: 2, reason: 'FX_UNSUPPORTED' }]);
  });

  it('skips rows outside any open fiscal period as NO_FISCAL_PERIOD — never clamps the date', async () => {
    const hasOpenFiscalPeriod = vi.fn(
      async (_org: string, d: Date) => d.getUTCFullYear() === 2026,
    );
    const csv = [
      'Date,Description,Amount',
      '2025-12-31,Old year charge,-10.00',
      '2026-07-02,Current charge,-20.00',
    ].join('\n');
    const deps = makeDeps({ hasOpenFiscalPeriod });
    const report = await ingestStatement(buf(csv), CTX, deps);
    expect(report.created).toBe(1);
    expect(report.skipped).toEqual([{ row: 2, reason: 'NO_FISCAL_PERIOD' }]);
    expect(hasOpenFiscalPeriod).toHaveBeenCalledWith(
      CTX.organizationId,
      new Date('2025-12-31T00:00:00.000Z'),
    );
    // The posted row kept its own date — nothing was shifted into a period.
    expect(deps.postedInputs).toHaveLength(1);
    expect((deps.postedInputs[0].date as Date).toISOString().slice(0, 10)).toBe('2026-07-02');
  });

  it('does not consult the fiscal period for rows already deduped', async () => {
    const deps = makePersistentDeps();
    await ingestStatement(buf(WISE_CSV), CTX, deps);
    (deps.hasOpenFiscalPeriod as ReturnType<typeof vi.fn>).mockClear();
    await ingestStatement(buf(WISE_CSV), CTX, deps);
    expect(deps.hasOpenFiscalPeriod).not.toHaveBeenCalled();
  });

  it('reports unparseable dates and amounts as failures without aborting the file', async () => {
    const csv = [
      'Date,Description,Amount',
      'not-a-date,Bad date row,-10.00',
      '2026-07-02,Bad amount row,ten rupees',
      '2026-07-03,Good row,-30.00',
    ].join('\n');
    const deps = makeDeps();
    const report = await ingestStatement(buf(csv), CTX, deps);
    expect(report.created).toBe(1);
    expect(report.failures).toHaveLength(2);
    expect(report.failures[0]).toMatchObject({ row: 2 });
    expect(report.failures[0].error).toMatch(/date/i);
    expect(report.failures[1]).toMatchObject({ row: 3 });
    expect(report.failures[1].error).toMatch(/amount/i);
  });

  it('a per-row postEntry failure never aborts the remaining rows', async () => {
    let call = 0;
    const deps = makeDeps({
      postEntry: vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error('boom');
        return { id: `je_${call}` };
      }),
    });
    const report = await ingestStatement(buf(GENERIC_CSV), CTX, deps);
    expect(report.created).toBe(1);
    expect(report.failures).toEqual([{ row: 2, error: 'boom' }]);
  });

  it('reconciles: created + deduped + skipped + failures === totalRows', async () => {
    const csv = [
      'Date,Description,Amount,Currency',
      '2026-07-01,Good,-10.00,LKR', // created
      '2026-07-01,Good,-10.00,LKR', // in-file duplicate → deduped
      '2026-07-02,Zero,0.00,LKR', // skipped ZERO_AMOUNT
      '2026-07-03,Foreign,-5.00,USD', // skipped FX_UNSUPPORTED
      'garbage,Bad date,-1.00,LKR', // failure
      '2026-07-04,Another good,25.00,LKR', // created
    ].join('\n');
    const deps = makeDeps();
    const report = await ingestStatement(buf(csv), CTX, deps);
    expect(report.totalRows).toBe(6);
    expect(report.created).toBe(2);
    expect(report.deduped).toBe(1);
    expect(report.skipped).toHaveLength(2);
    expect(report.failures).toHaveLength(1);
    expect(
      report.created + report.deduped + report.skipped.length + report.failures.length,
    ).toBe(report.totalRows);
  });
});

// ─── decimal precision ────────────────────────────────────────────────────────

describe('statement-ingest — decimal precision', () => {
  it('carries large amounts exactly through Decimal (never Number)', async () => {
    const csv = ['Date,Description,Amount', '2026-07-01,Large payout,1234567.89'].join('\n');
    const deps = makeDeps();
    const report = await ingestStatement(buf(csv), CTX, deps);
    expect(report.inflowTotal).toBe('1234567.89');
    const line = deps.postedInputs[0].lines[0];
    expect(line.amount).toBeInstanceOf(Decimal);
    expect((line.amount as Decimal).toFixed(2)).toBe('1234567.89');
  });

  it('strips thousands separators without losing precision', async () => {
    const csv = ['Date,Description,Amount', '2026-07-01,Payout,"1,234,567.89"'].join('\n');
    const deps = makeDeps();
    const report = await ingestStatement(buf(csv), CTX, deps);
    expect(report.inflowTotal).toBe('1234567.89');
  });
});

// ─── DRAFT-only rule ──────────────────────────────────────────────────────────

describe('statement-ingest — DRAFT-only', () => {
  it('creates every entry as DRAFT — there is no parameter that can force POSTED', async () => {
    const deps = makeDeps();
    await ingestStatement(buf(WISE_CSV), CTX, deps);
    for (const input of deps.postedInputs) {
      expect(input.status).toBe('DRAFT');
      expect(input.status).not.toBe('POSTED');
    }
  });
});

// ─── file guards ──────────────────────────────────────────────────────────────

describe('statement-ingest — file guards', () => {
  it('rejects an upload over the byte cap (FILE_TOO_LARGE)', async () => {
    // Limit injected small so the test stays fast; the 5 MB default is
    // pinned in the constants suite.
    const deps = makeDeps();
    try {
      await ingestStatement(buf(GENERIC_CSV), CTX, deps, { maxUploadBytes: 8 });
      expect.unreachable('expected FILE_TOO_LARGE');
    } catch (err) {
      expect(err).toBeInstanceOf(StatementIngestError);
      expect((err as StatementIngestError).code).toBe('FILE_TOO_LARGE');
    }
    expect(deps.postEntry).not.toHaveBeenCalled();
  });

  it('rejects a statement with more data rows than the cap (TOO_MANY_ROWS)', async () => {
    const deps = makeDeps();
    try {
      await ingestStatement(buf(GENERIC_CSV), CTX, deps, { maxRows: 1 });
      expect.unreachable('expected TOO_MANY_ROWS');
    } catch (err) {
      expect(err).toBeInstanceOf(StatementIngestError);
      expect((err as StatementIngestError).code).toBe('TOO_MANY_ROWS');
    }
  });

  it('accepts exactly maxRows data rows (boundary)', async () => {
    const deps = makeDeps();
    const report = await ingestStatement(buf(GENERIC_CSV), CTX, deps, { maxRows: 2 });
    expect(report.created).toBe(2);
  });

  it('rejects an empty file (INVALID_CSV)', async () => {
    const deps = makeDeps();
    try {
      await ingestStatement(buf(''), CTX, deps);
      expect.unreachable('expected INVALID_CSV');
    } catch (err) {
      expect(err).toBeInstanceOf(StatementIngestError);
      expect((err as StatementIngestError).code).toBe('INVALID_CSV');
    }
  });
});

// ─── evidence ─────────────────────────────────────────────────────────────────

describe('statement-ingest — evidence', () => {
  it('records one summary event with the file hash and run counts', async () => {
    const deps = makeDeps();
    const report = await ingestStatement(buf(WISE_CSV), CTX, deps);

    const calls = (deps.recordEvidence as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(1);
    const evidence = calls[0];
    expect(evidence.eventType).toBe('STATEMENT_INGEST_COMPLETED');
    expect(evidence.tenantId).toBe(CTX.organizationId);
    expect(evidence.makerIdentity).toBe(AUTOMATION_MAKER_IDENTITY);
    expect(evidence.payload).toMatchObject({
      statementHash: report.statementHash,
      totalRows: 2,
      created: 2,
      deduped: 0,
      skipped: [],
      failures: [],
      inflowTotal: '120000.00',
      outflowTotal: '4500.00',
    });
  });
});
