/**
 * S1b — staging→ledger bridge (`raj_fin_track.ocr_receipts` → JournalEntry).
 *
 * Contract under test: docs/runs/S1B-BRIDGE-CONTRACT.md.
 *   - Eligibility: POST only when ocr_status='success' AND total_amount>0
 *     AND doc_date present AND currency='LKR' AND an open FiscalPeriod covers
 *     doc_date; everything else PARKS with a reason code (OCR_FAILED |
 *     NO_DOC_DATE | BAD_AMOUNT | FX_UNSUPPORTED | NO_FISCAL_PERIOD).
 *   - Idempotency key = 'ocr-receipt:' + source_file (replay-safe).
 *   - Status is ALWAYS DRAFT via gateAutomatedJournalEntry — no confidence
 *     score (including exactly 1.0) can force POSTED.
 *   - Batched (default 50), per-row failure isolation, and the summary
 *     reconciles: posted + skipped_existing + failed + parked = input count.
 *
 * Pure deps-injection tests — the core (src/lib/ocr-bridge.ts) has zero
 * Prisma imports, so no database or mocking of the prisma singleton is needed.
 */
import { describe, it, expect, vi } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  classifyStagingRow,
  buildJournalInput,
  extractConfidence,
  importOcrReceipts,
  DEFAULT_BATCH_SIZE,
  type OcrStagingRow,
  type OcrBridgeDeps,
} from '../../src/lib/ocr-bridge';
import { JournalStatus } from '../../src/lib/types';

// ─── Fixtures ────────────────────────────────────────────────────────────────

let nextId = 1;

/** A fully eligible (POST) staging row; override fields to make it park. */
function makeRow(overrides: Partial<OcrStagingRow> = {}): OcrStagingRow {
  const id = nextId++;
  return {
    id,
    source_file: `receipt-${id}.jpg`,
    doc_date: new Date('2026-06-15T00:00:00Z'),
    vendor_or_entity: 'Keells Super',
    total_amount: '4500.0000', // pg numeric arrives as text via $queryRaw
    currency: 'LKR',
    category: 'Groceries',
    raw_response: null,
    ocr_status: 'success',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<OcrBridgeDeps> = {}): OcrBridgeDeps {
  return {
    ensureVendor: vi.fn().mockResolvedValue(undefined),
    resolveExpenseAccountId: vi.fn().mockResolvedValue('acct-expense'),
    resolveBankAccountId: vi.fn().mockResolvedValue('acct-bank'),
    postEntry: vi.fn().mockResolvedValue({ entryId: 'je-1', created: true }),
    hasOpenFiscalPeriod: vi.fn().mockResolvedValue(true),
    countRemainingEligible: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

const ORG = 'org-1';

// ─── Eligibility classification ──────────────────────────────────────────────

describe('classifyStagingRow', () => {
  it('POSTs a success row with positive LKR amount and a doc_date', () => {
    expect(classifyStagingRow(makeRow())).toEqual({ kind: 'POST' });
  });

  it('parks OCR_FAILED when ocr_status is not "success"', () => {
    expect(classifyStagingRow(makeRow({ ocr_status: 'failed' }))).toEqual({
      kind: 'PARK',
      reason: 'OCR_FAILED',
    });
  });

  it('parks OCR_FAILED when ocr_status is null (boundary)', () => {
    expect(classifyStagingRow(makeRow({ ocr_status: null }))).toEqual({
      kind: 'PARK',
      reason: 'OCR_FAILED',
    });
  });

  it('parks BAD_AMOUNT when total_amount is exactly 0 (boundary)', () => {
    expect(classifyStagingRow(makeRow({ total_amount: '0.0000' }))).toEqual({
      kind: 'PARK',
      reason: 'BAD_AMOUNT',
    });
  });

  it('parks BAD_AMOUNT when total_amount is null', () => {
    expect(classifyStagingRow(makeRow({ total_amount: null }))).toEqual({
      kind: 'PARK',
      reason: 'BAD_AMOUNT',
    });
  });

  it('parks BAD_AMOUNT when total_amount is negative', () => {
    expect(classifyStagingRow(makeRow({ total_amount: '-12.5000' }))).toEqual({
      kind: 'PARK',
      reason: 'BAD_AMOUNT',
    });
  });

  it('parks BAD_AMOUNT when total_amount is not numeric', () => {
    expect(classifyStagingRow(makeRow({ total_amount: 'garbage' }))).toEqual({
      kind: 'PARK',
      reason: 'BAD_AMOUNT',
    });
  });

  it('parks NO_DOC_DATE when doc_date is null — dates are never fabricated', () => {
    expect(classifyStagingRow(makeRow({ doc_date: null }))).toEqual({
      kind: 'PARK',
      reason: 'NO_DOC_DATE',
    });
  });

  it('parks NO_DOC_DATE when doc_date is unparseable', () => {
    expect(classifyStagingRow(makeRow({ doc_date: 'not-a-date' }))).toEqual({
      kind: 'PARK',
      reason: 'NO_DOC_DATE',
    });
  });

  it('parks FX_UNSUPPORTED for non-LKR currency', () => {
    for (const currency of ['GBP', 'USD', 'other']) {
      expect(classifyStagingRow(makeRow({ currency }))).toEqual({
        kind: 'PARK',
        reason: 'FX_UNSUPPORTED',
      });
    }
  });

  it('parks FX_UNSUPPORTED when currency is null (boundary — LKR books only)', () => {
    expect(classifyStagingRow(makeRow({ currency: null }))).toEqual({
      kind: 'PARK',
      reason: 'FX_UNSUPPORTED',
    });
  });

  it('applies precedence: a failed-OCR row with a bad amount parks as OCR_FAILED', () => {
    expect(
      classifyStagingRow(makeRow({ ocr_status: 'error', total_amount: null, doc_date: null })),
    ).toEqual({ kind: 'PARK', reason: 'OCR_FAILED' });
  });
});

// ─── Journal input mapping ───────────────────────────────────────────────────

describe('buildJournalInput', () => {
  const ctx = { organizationId: ORG, expenseAccountId: 'acct-expense', bankAccountId: 'acct-bank' };

  it('derives the idempotency key as "ocr-receipt:" + source_file', () => {
    const input = buildJournalInput(makeRow({ source_file: 'scan 001.pdf' }), ctx);
    expect(input.idempotencyKey).toBe('ocr-receipt:scan 001.pdf');
  });

  it('sets source=OCR_RECEIPT, sourceId=String(id), maker identity and org', () => {
    const input = buildJournalInput(makeRow({ id: 42 }), ctx);
    expect(input.source).toBe('OCR_RECEIPT');
    expect(input.sourceId).toBe('42');
    expect(input.makerIdentity).toBe('booklets-automation-service');
    expect(input.organizationId).toBe(ORG);
    expect(input.tenantId).toBe(ORG);
  });

  it('builds the AUTOMATED S1b memo with the vendor name', () => {
    const input = buildJournalInput(
      makeRow({ source_file: 'r1.jpg', vendor_or_entity: 'Cargills' }),
      ctx,
    );
    expect(input.memo).toBe('AUTOMATED S1b: Receipt r1.jpg — Cargills');
  });

  it('falls back to "unknown vendor" in the memo when vendor_or_entity is null', () => {
    const input = buildJournalInput(
      makeRow({ source_file: 'r2.jpg', vendor_or_entity: null }),
      ctx,
    );
    expect(input.memo).toBe('AUTOMATED S1b: Receipt r2.jpg — unknown vendor');
  });

  it('uses doc_date as the entry date', () => {
    const input = buildJournalInput(makeRow({ doc_date: '2026-05-02' }), ctx);
    expect(input.date).toBeInstanceOf(Date);
    expect(input.date.toISOString().slice(0, 10)).toBe('2026-05-02');
  });

  it('creates exactly two balanced LKR lines: debit expense, credit bank', () => {
    const input = buildJournalInput(makeRow({ total_amount: '1234.5600' }), ctx);
    expect(input.lines).toHaveLength(2);

    const [debit, credit] = input.lines;
    expect(debit.accountId).toBe('acct-expense');
    expect(debit.isDebit).toBe(true);
    expect(debit.currency).toBe('LKR');
    expect(new Decimal(debit.amount.toString()).toFixed(4)).toBe('1234.5600');

    expect(credit.accountId).toBe('acct-bank');
    expect(credit.isDebit).toBe(false);
    expect(credit.currency).toBe('LKR');
    expect(new Decimal(credit.amount.toString()).toFixed(4)).toBe('1234.5600');
  });

  it('takes agentConfidence from raw_response when present', () => {
    const input = buildJournalInput(makeRow({ raw_response: { confidence: 0.87 } }), ctx);
    expect(input.agentConfidence).toBe(0.87);
  });

  it('leaves agentConfidence null when raw_response has no confidence', () => {
    expect(buildJournalInput(makeRow({ raw_response: null }), ctx).agentConfidence).toBeNull();
    expect(
      buildJournalInput(makeRow({ raw_response: { vendor: 'x' } }), ctx).agentConfidence,
    ).toBeNull();
  });
});

describe('extractConfidence', () => {
  it('returns a numeric top-level confidence', () => {
    expect(extractConfidence({ confidence: 0.5 })).toBe(0.5);
  });

  it('returns null for null, non-object, missing or non-numeric confidence', () => {
    expect(extractConfidence(null)).toBeNull();
    expect(extractConfidence('0.9')).toBeNull();
    expect(extractConfidence({})).toBeNull();
    expect(extractConfidence({ confidence: 'high' })).toBeNull();
  });
});

// ─── DRAFT-always (D3 gate) ──────────────────────────────────────────────────

describe('DRAFT-always via gateAutomatedJournalEntry', () => {
  const ctx = { organizationId: ORG, expenseAccountId: 'a', bankAccountId: 'b' };

  it('lands as DRAFT with no confidence at all', () => {
    expect(buildJournalInput(makeRow(), ctx).status).toBe(JournalStatus.DRAFT);
  });

  it('lands as DRAFT even at confidence 1.0 — no score can force POSTED', () => {
    for (const confidence of [0.5, 0.95, 0.99999, 1.0]) {
      const input = buildJournalInput(makeRow({ raw_response: { confidence } }), ctx);
      expect(input.status).toBe(JournalStatus.DRAFT);
    }
  });

  it('never hands postEntry anything but DRAFT across a whole batch', async () => {
    const posted: string[] = [];
    const deps = makeDeps({
      postEntry: vi.fn(async (input) => {
        posted.push(input.status as string);
        return { entryId: `je-${posted.length}`, created: true };
      }),
    });
    const rows = [
      makeRow({ raw_response: { confidence: 1.0 } }),
      makeRow({ raw_response: { confidence: 0.99 } }),
      makeRow(),
    ];
    await importOcrReceipts(rows, deps, { organizationId: ORG });
    expect(posted).toEqual([JournalStatus.DRAFT, JournalStatus.DRAFT, JournalStatus.DRAFT]);
  });

  it('fails the row loudly (not silently posted) when raw confidence is out of contract', async () => {
    const deps = makeDeps();
    const rows = [makeRow({ raw_response: { confidence: 1.5 } })];
    const summary = await importOcrReceipts(rows, deps, { organizationId: ORG });
    expect(summary.posted).toBe(0);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0].id).toBe(rows[0].id);
    // The gate rejects BEFORE any writes for that row.
    expect(deps.postEntry).not.toHaveBeenCalled();
    expect(deps.ensureVendor).not.toHaveBeenCalled();
  });
});

// ─── Importer orchestration ──────────────────────────────────────────────────

describe('importOcrReceipts', () => {
  it('exposes the contract default batch size of 50', () => {
    expect(DEFAULT_BATCH_SIZE).toBe(50);
  });

  it('processes at most batchSize rows per invocation', async () => {
    const deps = makeDeps({ countRemainingEligible: vi.fn().mockResolvedValue(3) });
    const rows = Array.from({ length: 5 }, () => makeRow());
    const summary = await importOcrReceipts(rows, deps, { organizationId: ORG, batchSize: 2 });
    expect(deps.postEntry).toHaveBeenCalledTimes(2);
    expect(summary.posted).toBe(2);
    expect(summary.remaining).toBe(3);
  });

  it('defaults the batch size to 50', async () => {
    const deps = makeDeps();
    const rows = Array.from({ length: 60 }, () => makeRow());
    const summary = await importOcrReceipts(rows, deps, { organizationId: ORG });
    expect(deps.postEntry).toHaveBeenCalledTimes(50);
    expect(summary.posted).toBe(50);
  });

  it('counts idempotency conflicts as skipped_existing, not errors', async () => {
    const deps = makeDeps({
      postEntry: vi
        .fn()
        .mockResolvedValueOnce({ entryId: 'je-1', created: true })
        .mockResolvedValueOnce({ entryId: 'je-old', created: false })
        .mockResolvedValueOnce({ entryId: 'je-2', created: true }),
    });
    const summary = await importOcrReceipts([makeRow(), makeRow(), makeRow()], deps, {
      organizationId: ORG,
    });
    expect(summary.posted).toBe(2);
    expect(summary.skipped_existing).toBe(1);
    expect(summary.failed).toEqual([]);
  });

  it('counts a concurrent-race loser as skipped_existing, not posted (TOCTOU)', async () => {
    // Two imports race over the SAME staging rows. The shared "database"
    // below models postEntryWithOutcome: the first writer of a key persists
    // it (created: true); the race loser observes the existing row and gets
    // created: false. Both runs must reconcile without double-counting.
    const persisted = new Set<string>();
    function racingDeps(): OcrBridgeDeps {
      return makeDeps({
        postEntry: vi.fn(async (input) => {
          const key = input.idempotencyKey as string;
          if (persisted.has(key)) return { entryId: `je-${key}`, created: false };
          // Yield before the "write" so the two runs genuinely interleave.
          await Promise.resolve();
          if (persisted.has(key)) return { entryId: `je-${key}`, created: false };
          persisted.add(key);
          return { entryId: `je-${key}`, created: true };
        }),
      });
    }
    const rows = [makeRow(), makeRow(), makeRow()];
    const [a, b] = await Promise.all([
      importOcrReceipts(rows, racingDeps(), { organizationId: ORG }),
      importOcrReceipts(rows, racingDeps(), { organizationId: ORG }),
    ]);
    // Each row is created exactly once across both runs; every other attempt
    // is a skip. Nothing fails and nothing is double-posted.
    expect(a.posted + b.posted).toBe(rows.length);
    expect(a.skipped_existing + b.skipped_existing).toBe(rows.length);
    expect(a.failed).toEqual([]);
    expect(b.failed).toEqual([]);
    expect(a.posted + a.skipped_existing).toBe(rows.length);
    expect(b.posted + b.skipped_existing).toBe(rows.length);
  });

  it('isolates per-row failures: one bad row does not abort the batch', async () => {
    let call = 0;
    const deps = makeDeps({
      postEntry: vi.fn(async () => {
        call += 1;
        if (call === 2) throw new Error('fiscal period closed');
        return { entryId: `je-${call}`, created: true };
      }),
    });
    const rows = [makeRow(), makeRow(), makeRow()];
    const summary = await importOcrReceipts(rows, deps, { organizationId: ORG });
    expect(summary.posted).toBe(2);
    expect(summary.failed).toEqual([{ id: rows[1].id, error: 'fiscal period closed' }]);
  });

  it('aggregates parked rows by reason with their staging ids', async () => {
    const deps = makeDeps();
    const failedOcr = makeRow({ ocr_status: 'failed' });
    const noDate1 = makeRow({ doc_date: null });
    const noDate2 = makeRow({ doc_date: null });
    const fx = makeRow({ currency: 'USD' });
    const summary = await importOcrReceipts([failedOcr, noDate1, noDate2, fx], deps, {
      organizationId: ORG,
    });
    expect(summary.posted).toBe(0);
    expect(summary.parked).toEqual(
      expect.arrayContaining([
        { reason: 'OCR_FAILED', count: 1, ids: [failedOcr.id] },
        { reason: 'NO_DOC_DATE', count: 2, ids: [noDate1.id, noDate2.id] },
        { reason: 'FX_UNSUPPORTED', count: 1, ids: [fx.id] },
      ]),
    );
    expect(summary.parked).toHaveLength(3); // no empty reason buckets
    expect(summary.parkedPermanently).toBe(4);
  });

  // ─── NO_FISCAL_PERIOD (audit blocking finding #4) ──────────────────────────

  it('parks NO_FISCAL_PERIOD when no open fiscal period covers doc_date — no entry, no failure', async () => {
    const deps = makeDeps({ hasOpenFiscalPeriod: vi.fn().mockResolvedValue(false) });
    const row = makeRow({ doc_date: new Date('2025-03-10T00:00:00Z') });
    const summary = await importOcrReceipts([row], deps, { organizationId: ORG });
    expect(summary.parked).toEqual([{ reason: 'NO_FISCAL_PERIOD', count: 1, ids: [row.id] }]);
    expect(summary.parkedPermanently).toBe(1);
    expect(summary.posted).toBe(0);
    expect(summary.failed).toEqual([]); // parked, NOT stranded in failed
    // Parking means NO writes of any kind: no JournalEntry, no vendor,
    // no account/category rows.
    expect(deps.postEntry).not.toHaveBeenCalled();
    expect(deps.ensureVendor).not.toHaveBeenCalled();
    expect(deps.resolveExpenseAccountId).not.toHaveBeenCalled();
  });

  it('checks the period with the row doc_date and never clamps a date into one (contract §7)', async () => {
    const hasOpenFiscalPeriod = vi.fn(async (d: Date) => d.getUTCFullYear() === 2026);
    const deps = makeDeps({ hasOpenFiscalPeriod });
    const inPeriod = makeRow({ doc_date: new Date('2026-06-15T00:00:00Z') });
    const outOfPeriod = makeRow({ doc_date: new Date('2024-12-31T00:00:00Z') });
    const summary = await importOcrReceipts([inPeriod, outOfPeriod], deps, {
      organizationId: ORG,
    });
    expect(hasOpenFiscalPeriod).toHaveBeenCalledWith(new Date('2024-12-31T00:00:00Z'));
    expect(summary.posted).toBe(1);
    expect(summary.parked).toEqual([
      { reason: 'NO_FISCAL_PERIOD', count: 1, ids: [outOfPeriod.id] },
    ]);
    // The row that DID post kept its own doc_date untouched.
    const input = vi.mocked(deps.postEntry).mock.calls[0][0];
    expect((input.date as Date).toISOString().slice(0, 10)).toBe('2026-06-15');
  });

  it('pure park reasons take precedence — the fiscal period is never consulted for them', async () => {
    const deps = makeDeps({ hasOpenFiscalPeriod: vi.fn().mockResolvedValue(false) });
    const summary = await importOcrReceipts([makeRow({ doc_date: null })], deps, {
      organizationId: ORG,
    });
    expect(summary.parked).toEqual([{ reason: 'NO_DOC_DATE', count: 1, ids: expect.any(Array) }]);
    expect(deps.hasOpenFiscalPeriod).not.toHaveBeenCalled();
  });

  it('reconciles: posted + skipped_existing + failed + parked === input count', async () => {
    let call = 0;
    const deps = makeDeps({
      postEntry: vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error('boom');
        if (call === 2) return { entryId: 'je-existing', created: false };
        return { entryId: `je-${call}`, created: true };
      }),
    });
    const rows = [
      makeRow(), // fails (boom)
      makeRow(), // skipped_existing
      makeRow(), // posted
      makeRow(), // posted
      makeRow({ ocr_status: 'failed' }),
      makeRow({ doc_date: null }),
      makeRow({ total_amount: '0' }),
      makeRow({ currency: 'GBP' }),
    ];
    const summary = await importOcrReceipts(rows, deps, { organizationId: ORG });
    const parkedTotal = summary.parked.reduce((acc, p) => acc + p.count, 0);
    expect(summary.posted).toBe(2);
    expect(summary.skipped_existing).toBe(1);
    expect(summary.failed).toHaveLength(1);
    expect(parkedTotal).toBe(4);
    expect(summary.parkedPermanently).toBe(parkedTotal);
    expect(summary.posted + summary.skipped_existing + summary.failed.length + parkedTotal).toBe(
      rows.length,
    );
  });

  it('resolves the expense account from the row category and credits the bank account', async () => {
    const captured: unknown[] = [];
    const deps = makeDeps({
      resolveExpenseAccountId: vi.fn().mockResolvedValue('acct-utilities'),
      postEntry: vi.fn(async (input) => {
        captured.push(input);
        return { entryId: 'je-1', created: true };
      }),
    });
    const row = makeRow({ category: 'Utilities' });
    await importOcrReceipts([row], deps, { organizationId: ORG });
    expect(deps.resolveExpenseAccountId).toHaveBeenCalledWith('Utilities');
    const input = captured[0] as ReturnType<typeof buildJournalInput>;
    expect(input.lines[0].accountId).toBe('acct-utilities');
    expect(input.lines[1].accountId).toBe('acct-bank');
  });

  it('resolves-or-creates the vendor for posted rows, but not for null vendors', async () => {
    const deps = makeDeps();
    await importOcrReceipts(
      [makeRow({ vendor_or_entity: 'Cargills' }), makeRow({ vendor_or_entity: null })],
      deps,
      { organizationId: ORG },
    );
    expect(deps.ensureVendor).toHaveBeenCalledTimes(1);
    expect(deps.ensureVendor).toHaveBeenCalledWith('Cargills');
  });

  it('never touches vendor/account/post deps for parked rows', async () => {
    const deps = makeDeps();
    await importOcrReceipts(
      [makeRow({ ocr_status: 'failed' }), makeRow({ currency: 'USD' })],
      deps,
      { organizationId: ORG },
    );
    expect(deps.ensureVendor).not.toHaveBeenCalled();
    expect(deps.resolveExpenseAccountId).not.toHaveBeenCalled();
    expect(deps.postEntry).not.toHaveBeenCalled();
  });

  it('reports remaining from the deps count so callers can re-invoke until 0', async () => {
    const deps = makeDeps({ countRemainingEligible: vi.fn().mockResolvedValue(129) });
    const summary = await importOcrReceipts([makeRow()], deps, { organizationId: ORG });
    expect(summary.remaining).toBe(129);
  });
});
